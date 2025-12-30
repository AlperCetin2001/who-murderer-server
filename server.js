const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());

// -----------------------------------------------------------
// 1. DEĞİŞİKLİK: 'public' yerine 'htdocs' yapıldı
// -----------------------------------------------------------
app.use(express.static(path.join(__dirname, 'htdocs')));

// ÇEVİRİ PROXY (Aynı kalıyor - Ücretsiz ve Engelsiz)
app.post('/api/translate', async (req, res) => {
    const { text, targetLang } = req.body;
    if (!text) return res.status(400).json({ error: 'Metin yok' });
    if (targetLang === 'tr') return res.json({ translatedText: text });

    try {
        const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=tr&tl=${targetLang}&dt=t&q=${encodeURIComponent(text)}`;
        const response = await fetch(url);
        const data = await response.json();
        
        if (data && data[0]) {
            const translatedText = data[0].map(segment => segment[0]).join('');
            return res.json({ translatedText });
        }
        res.json({ translatedText: text });
    } catch (error) {
        console.error('Çeviri hatası:', error);
        res.json({ translatedText: text });
    }
});

const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*", methods: ["GET", "POST"] }
});

const rooms = new Map();
const scenesCache = {}; 

// -----------------------------------------------------------
// 2. DEĞİŞİKLİK: Senaryo yükleme yolu 'htdocs/data' yapıldı
// -----------------------------------------------------------
function loadCaseData(caseId) {
    if (scenesCache[caseId]) return scenesCache[caseId];
    try {
        // BURASI DEĞİŞTİ: public -> htdocs
        const dataPath = path.join(__dirname, 'htdocs', 'data', `scenes${caseId.replace('case', '')}.json`);
        
        if (!fs.existsSync(dataPath)) {
            console.error(`Dosya bulunamadı: ${dataPath}`);
            return null;
        }

        const rawData = fs.readFileSync(dataPath);
        const jsonData = JSON.parse(rawData);
        scenesCache[caseId] = jsonData;
        return jsonData;
    } catch (err) {
        console.error(`Senaryo yükleme hatası (${caseId}):`, err);
        return null;
    }
}

// ... STANDART SOCKET KODLARI (Aynı Kalıyor) ...

function generateRoomCode() {
    const chars = "BCDFGHJKMNPQRSTVWXYZ23456789";
    let code = "";
    for (let i = 0; i < 4; i++) {
        code += chars.charAt(Math.floor(Math.random() * chars.length));
    }
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
    console.log(`🔌 Yeni bağlantı: ${socket.id}`);
    socket.emit('room_list_update', getPublicRoomList());

    socket.on('create_room', ({ playerName, visibility, password, avatar }) => {
        let roomCode = generateRoomCode();
        while(rooms.has(roomCode)) { roomCode = generateRoomCode(); }

        rooms.set(roomCode, {
            host: socket.id,
            players: [{ id: socket.id, name: playerName, score: 0, avatar: avatar || '🕵️' }],
            gameState: 'lobby',
            mode: 'individual', 
            votes: {},          
            currentCaseId: null,
            currentSceneId: 'giris',
            isPrivate: (visibility === 'private'),
            password: (visibility === 'protected' && password) ? password : null,
            hintCount: 3
        });

        socket.join(roomCode);
        socket.emit('room_created', { roomCode, isHost: true });
        io.emit('room_list_update', getPublicRoomList());
        io.to(roomCode).emit('update_player_list', rooms.get(roomCode).players);
        
        io.to(roomCode).emit('chat_message', { 
            sender: 'Sistem', 
            text: `Oda kuruldu. Dedektif ${playerName} giriş yaptı.`, 
            type: 'system' 
        });
    });

    socket.on('join_room', ({ roomCode, playerName, password, avatar }) => {
        const room = rooms.get(roomCode);
        if (!room) return socket.emit('error_message', '❌ Böyle bir oda bulunamadı!');
        if (room.gameState !== 'lobby') return socket.emit('error_message', '⚠️ Oyun çoktan başladı!');
        if (room.password && room.password !== password) return socket.emit('error_message', '🔒 Yanlış Şifre!');

        const nameExists = room.players.some(p => p.name === playerName);
        if (nameExists) return socket.emit('error_message', '⚠️ Bu isim zaten odada var!');

        room.players.push({ id: socket.id, name: playerName, score: 0, avatar: avatar || '🕵️' });
        socket.join(roomCode);

        socket.emit('join_success', { roomCode, isHost: false });
        io.to(roomCode).emit('update_player_list', room.players);
        io.emit('room_list_update', getPublicRoomList());

        io.to(roomCode).emit('chat_message', { 
            sender: 'Sistem', 
            text: `${playerName} ekibe katıldı.`, 
            type: 'join' 
        });
    });

    socket.on('send_chat', ({ roomCode, message, playerName, avatar }) => {
        if (!message || message.trim().length === 0) return;
        const safeMessage = message.substring(0, 500); 
        io.to(roomCode).emit('chat_message', { 
            sender: playerName, 
            text: safeMessage, 
            avatar: avatar,
            id: socket.id,
            type: 'user'
        });
    });

    socket.on('start_game', ({ roomCode, caseId, mode }) => {
        const room = rooms.get(roomCode);
        if (room && room.host === socket.id) {
            const caseData = loadCaseData(caseId);
            
            if (!caseData) {
                // Eğer dosya bulunamazsa host'a hata ver
                socket.emit('error_message', 'Senaryo dosyası (htdocs/data içinde) bulunamadı!');
                return;
            }

            room.gameState = 'playing';
            room.currentCaseId = caseId;
            room.mode = mode || 'individual';
            room.hintCount = 3;
            room.currentSceneId = 'giris';
            
            io.to(roomCode).emit('clear_chat');
            io.to(roomCode).emit('game_started', { 
                mode: room.mode, 
                currentHintCount: 3 
            });

            sendSceneToRoom(roomCode, 'giris');
            io.emit('room_list_update', getPublicRoomList());
        }
    });

    socket.on('make_choice', ({ roomCode, nextSceneId }) => {
        const room = rooms.get(roomCode);
        if (!room) return;
        
        if (room.mode === 'individual') {
            sendSceneToSocket(socket, room.currentCaseId, nextSceneId);
        } else if (room.mode === 'voting') {
             handleVoting(socket, roomCode, nextSceneId);
        }
    });

    function handleVoting(socket, roomCode, nextSceneId) {
        const room = rooms.get(roomCode);
        room.votes[socket.id] = nextSceneId;
        
        const voteStatus = room.players.map(player => ({
            name: player.name,
            id: player.id,
            hasVoted: room.votes.hasOwnProperty(player.id),
        }));

        const playerCount = room.players.length;
        const voteCount = Object.keys(room.votes).length;

        io.to(roomCode).emit('vote_update', { voteStatus, voteCount, total: playerCount });

        if (voteCount >= playerCount) {
            const counts = {};
            let winnerScene = null;
            let maxVotes = 0;
            Object.values(room.votes).forEach(sceneId => {
                counts[sceneId] = (counts[sceneId] || 0) + 1;
                if (counts[sceneId] > maxVotes) { maxVotes = counts[sceneId]; winnerScene = sceneId; }
            });
            
            setTimeout(() => {
                room.votes = {}; 
                room.currentSceneId = winnerScene;
                sendSceneToRoom(roomCode, winnerScene);
            }, 3000);
        }
    }

    socket.on('request_hint', ({ roomCode, playerName }) => {
        const room = rooms.get(roomCode);
        if (!room) return;
        
        if (room.mode === 'voting') {
            if (room.hintCount > 0) {
                room.hintCount--;
                const currentSceneData = getSceneData(room.currentCaseId, room.currentSceneId);
                const hintText = currentSceneData ? (currentSceneData.hint || currentSceneData.hint_text) : "İpucu yok.";
                
                io.to(roomCode).emit('hint_revealed', { 
                    hintText: hintText, 
                    newCount: room.hintCount,
                    user: playerName
                });
            }
        } else {
             const currentSceneData = getSceneData(room.currentCaseId, 'giris');
        }
    });

    function sendSceneToSocket(socket, caseId, sceneId) {
        const sceneData = getSceneData(caseId, sceneId);
        if (sceneData) socket.emit('scene_data', sceneData);
    }

    function sendSceneToRoom(roomCode, sceneId) {
        const room = rooms.get(roomCode);
        const sceneData = getSceneData(room.currentCaseId, sceneId);
        if (sceneData) io.to(roomCode).emit('scene_data', sceneData);
    }

    function getSceneData(caseId, sceneId) {
        const caseJson = loadCaseData(caseId);
        if (!caseJson || !caseJson.scenes) return null;
        return caseJson.scenes.find(s => s.scene_id === sceneId);
    }
    
    socket.on('disconnect', () => {
         rooms.forEach((room, code) => {
            const playerIndex = room.players.findIndex(p => p.id === socket.id);
            if (playerIndex !== -1) {
                const pName = room.players[playerIndex].name;
                room.players.splice(playerIndex, 1); 
                io.to(code).emit('update_player_list', room.players);
                io.to(code).emit('chat_message', { sender: 'Sistem', text: `${pName} ayrıldı.`, type: 'leave' });
                if(room.players.length === 0) rooms.delete(code);
                else io.emit('room_list_update', getPublicRoomList());
            }
        });
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🚀 Sunucu ${PORT} portunda çalışıyor`);
});
