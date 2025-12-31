const fs = require('fs');
const path = require('path');
const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const cors = require('cors');

const app = express();
app.use(cors());

// Statik dosyaları sunmak için (public klasörü varsa)
app.use(express.static(path.join(__dirname, 'public')));

const server = http.createServer(app);

const io = new Server(server, {
    cors: { origin: "*", methods: ["GET", "POST"] }
});

const rooms = new Map();

// --- SENARYO YÜKLEME ---
const loadedScenarios = {};
function loadAllScenarios() {
    const dataFolderPath = path.join(__dirname, 'data');
    if (!fs.existsSync(dataFolderPath)) {
        console.error("❌ HATA: 'data' klasörü bulunamadı!");
        return;
    }
    ['case1', 'case2', 'case3'].forEach(caseId => {
        try {
            const fileName = `scenes${caseId.replace('case', '')}.json`;
            const filePath = path.join(dataFolderPath, fileName);
            if (fs.existsSync(filePath)) {
                const rawData = fs.readFileSync(filePath, 'utf8');
                loadedScenarios[caseId] = JSON.parse(rawData);
                console.log(`✅ ${caseId} yüklendi.`);
            }
        } catch (error) { console.error(`❌ ${caseId} yüklenemedi.`); }
    });
}
loadAllScenarios();

function generateRoomCode() {
    const chars = "BCDFGHJKMNPQRSTVWXYZ23456789";
    let code = "";
    for (let i = 0; i < 4; i++) { code += chars.charAt(Math.floor(Math.random() * chars.length)); }
    return code;
}

function getPublicRoomList() {
    const publicRooms = [];
    rooms.forEach((room, code) => {
        if (room.gameState === 'lobby' && !room.isPrivate) {
            publicRooms.push({
                code: code,
                host: room.players[0].name,
                count: room.players.length,
                isLocked: !!room.password, 
                mode: room.mode
            });
        }
    });
    return publicRooms;
}

io.on('connection', (socket) => {
    socket.emit('room_list_update', getPublicRoomList());

    socket.on('request_scene_data', ({ roomCode, sceneId }) => {
        const room = rooms.get(roomCode);
        if (!room) return;
        const caseData = loadedScenarios[room.currentCase]; 
        if (!caseData || !caseData.scenes) return;
        const sceneData = caseData.scenes.find(s => s.scene_id === sceneId);
        
        if (sceneData) {
            socket.emit('scene_data_update', sceneData);
            if (sceneData.image && !sceneData.image.includes('char_') && !sceneData.image.includes('dis.jpg')) {
                const exists = room.evidenceList.find(e => e.src === sceneData.image);
                if (!exists) {
                    const newEvidence = { id: 'ev_' + Date.now(), src: sceneData.image, x: 50, y: 50 };
                    room.evidenceList.push(newEvidence);
                    io.to(roomCode).emit('update_evidence_board', room.evidenceList);
                }
            }
        }
    });

    socket.on('move_evidence', ({ roomCode, id, x, y }) => {
        const room = rooms.get(roomCode);
        if (room) {
            const item = room.evidenceList.find(e => e.id === id);
            if (item) { item.x = x; item.y = y; io.to(roomCode).emit('evidence_moved', { id, x, y }); }
        }
    });

    socket.on('get_board_state', ({ roomCode }) => {
        const room = rooms.get(roomCode);
        if(room) socket.emit('update_evidence_board', room.evidenceList);
    });

    socket.on('create_room', ({ playerName, visibility, password, avatar }) => {
        let roomCode = generateRoomCode();
        while(rooms.has(roomCode)) { roomCode = generateRoomCode(); }
        rooms.set(roomCode, {
            host: socket.id,
            players: [{ id: socket.id, name: playerName, score: 0, avatar: avatar || '🕵️' }],
            gameState: 'lobby',
            mode: 'individual', 
            votes: {}, currentCase: null,
            isPrivate: (visibility === 'private'),
            password: (visibility === 'protected' && password) ? password : null,
            hintCount: 3, evidenceList: []
        });
        socket.join(roomCode);
        socket.emit('room_created', { roomCode, isHost: true });
        io.emit('room_list_update', getPublicRoomList());
        io.to(roomCode).emit('update_player_list', rooms.get(roomCode).players);
    });

    socket.on('join_room', ({ roomCode, playerName, password, avatar }) => {
        const room = rooms.get(roomCode);
        if (!room) return socket.emit('error_message', '❌ Oda bulunamadı!');
        
        let isReconnection = false;
        if (room.gameState !== 'lobby') { isReconnection = true; }

        if (room.password && room.password !== password) return socket.emit('error_message', '🔒 Yanlış Şifre!');

        if (!isReconnection) {
            const nameExists = room.players.some(p => p.name === playerName);
            if (nameExists) return socket.emit('error_message', '⚠️ İsim kullanımda!');
        }

        room.players.push({ id: socket.id, name: playerName, score: 0, avatar: avatar || '🕵️' });
        socket.join(roomCode);

        socket.emit('join_success', { roomCode, isHost: false });
        io.to(roomCode).emit('update_player_list', room.players);
        
        if(isReconnection) {
            io.to(roomCode).emit('chat_message', { sender: 'Sistem', text: `🔄 ${playerName} odaya tekrar bağlandı.`, type: 'join' });
            if(room.currentCase) socket.emit('game_started', { caseId: room.currentCase, mode: room.mode, currentHintCount: room.hintCount });
        } else {
            io.to(roomCode).emit('chat_message', { sender: 'Sistem', text: `${playerName} katıldı.`, type: 'join' });
        }
        io.emit('room_list_update', getPublicRoomList());
    });

    socket.on('send_chat', ({ roomCode, message, playerName, avatar }) => {
        io.to(roomCode).emit('chat_message', { sender: playerName, text: message, avatar: avatar, id: socket.id, type: 'user' });
    });

    socket.on('start_game', ({ roomCode, caseId, mode }) => {
        const room = rooms.get(roomCode);
        if (room && room.host === socket.id) {
            room.gameState = 'playing';
            room.currentCase = caseId;
            room.mode = mode || 'individual';
            room.hintCount = 3;
            room.evidenceList = [];
            room.votes = {};
            io.to(roomCode).emit('game_started', { caseId, mode: room.mode, currentHintCount: 3 });
            io.emit('room_list_update', getPublicRoomList());
        }
    });

    socket.on('cast_vote', ({ roomCode, nextSceneId }) => {
        const room = rooms.get(roomCode);
        if (!room || room.mode !== 'voting') return;
        room.votes[socket.id] = nextSceneId;
        
        const voteStatus = room.players.map(p => ({
            name: p.name, id: p.id, avatar: p.avatar,
            hasVoted: room.votes.hasOwnProperty(p.id), 
            votedForId: room.votes[p.id] || null 
        }));

        const playerCount = room.players.length;
        const voteCount = Object.keys(room.votes).length;
        io.to(roomCode).emit('vote_update', { voteStatus, voteCount, total: playerCount });

        if (voteCount >= playerCount) {
            const counts = {};
            let winnerScene = null;
            let maxVotes = 0;
            Object.values(room.votes).forEach(sid => {
                counts[sid] = (counts[sid] || 0) + 1;
                if (counts[sid] > maxVotes) { maxVotes = counts[sid]; winnerScene = sid; }
            });
            setTimeout(() => {
                room.votes = {}; 
                io.to(roomCode).emit('force_scene_change', winnerScene);
            }, 3000);
        }
    });

    socket.on('request_hint', ({ roomCode, hintText, playerName }) => {
        const room = rooms.get(roomCode);
        if (room && room.mode === 'voting' && room.hintCount > 0) {
            room.hintCount--;
            io.to(roomCode).emit('hint_revealed', { hintText, newCount: room.hintCount, user: playerName });
        }
    });

    socket.on('get_public_rooms', () => { socket.emit('room_list_update', getPublicRoomList()); });

    socket.on('disconnect', () => {
        rooms.forEach((room, code) => {
            const playerIndex = room.players.findIndex(p => p.id === socket.id);
            if (playerIndex !== -1) {
                room.players.splice(playerIndex, 1); 
                io.to(code).emit('update_player_list', room.players);
                if(room.players.length === 0) rooms.delete(code);
                else io.emit('room_list_update', getPublicRoomList());
            }
        });
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => { console.log(`🚀 Sunucu Port ${PORT} üzerinde çalışıyor`); });
