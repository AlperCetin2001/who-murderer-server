const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const cors = require('cors');

const app = express();
app.use(cors());

const server = http.createServer(app);

const io = new Server(server, {
    cors: { origin: "*", methods: ["GET", "POST"] }
});

const rooms = new Map();

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
            currentCase: null,
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
        io.to(roomCode).emit('chat_message', { 
            sender: playerName, 
            text: message, 
            avatar: avatar,
            id: socket.id,
            type: 'user'
        });
    });

    socket.on('typing', ({ roomCode, playerName, isTyping }) => {
        socket.to(roomCode).emit('user_typing', { playerName, isTyping });
    });

    socket.on('start_game', ({ roomCode, caseId, mode }) => {
        const room = rooms.get(roomCode);
        if (room && room.host === socket.id) {
            if (mode === 'voting' && room.players.length < 3) {
                socket.emit('error_message', '⚠️ Demokrasi modu için en az 3 dedektif gereklidir!');
                return;
            }

            room.gameState = 'playing';
            room.currentCase = caseId;
            room.mode = mode || 'individual';
            room.hintCount = 3; 
            
            io.to(roomCode).emit('clear_chat');
            io.to(roomCode).emit('chat_message', { sender: 'Sistem', text: '--- YENİ DAVA BAŞLADI ---', type: 'system' });

            // GÜNCEL İPUCU SAYISINI GÖNDERİYORUZ
            io.to(roomCode).emit('game_started', { 
                caseId, 
                mode: room.mode, 
                currentHintCount: 3 
            });
            io.emit('room_list_update', getPublicRoomList());
        }
    });

    socket.on('cast_vote', ({ roomCode, nextSceneId }) => {
        const room = rooms.get(roomCode);
        if (!room || room.mode !== 'voting') return;
        room.votes[socket.id] = nextSceneId;
        
        const voteStatus = room.players.map(player => ({
            name: player.name,
            id: player.id,
            hasVoted: room.votes.hasOwnProperty(player.id),
            votedForId: room.votes[player.id] || null 
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
                io.to(roomCode).emit('force_scene_change', winnerScene);
            }, 3000);
        }
    });

    // İPUCU İSTEĞİ (DÜZELTİLDİ)
    socket.on('request_hint', ({ roomCode, hintText, playerName }) => {
        const room = rooms.get(roomCode);
        if (room && room.mode === 'voting') {
            if (room.hintCount > 0) {
                room.hintCount--; // Sunucuda azalt
                // HERKESE GÖNDER
                io.to(roomCode).emit('hint_revealed', { hintText, newCount: room.hintCount, user: playerName });
            }
        }
    });

    socket.on('get_public_rooms', () => { socket.emit('room_list_update', getPublicRoomList()); });

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
    console.log(`🚀 Sunucu çalışıyor`);
});
