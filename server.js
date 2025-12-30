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

// Açık odaları listele
function getPublicRoomList() {
    const publicRooms = [];
    rooms.forEach((room, code) => {
        // Sadece 'lobby' aşamasındaki ve 'private' olmayanları göster
        if (room.gameState === 'lobby' && !room.isPrivate) {
            publicRooms.push({
                code: code,
                host: room.players[0].name, // İlk oyuncu hosttur
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

    // Bağlanana listeyi gönder
    socket.emit('room_list_update', getPublicRoomList());

    // 1. ODA OLUŞTURMA
    socket.on('create_room', ({ playerName, visibility, password }) => {
        let roomCode = generateRoomCode();
        while(rooms.has(roomCode)) { roomCode = generateRoomCode(); }

        const isPrivate = (visibility === 'private');
        const roomPassword = (visibility === 'protected' && password) ? password : null;

        rooms.set(roomCode, {
            host: socket.id,
            players: [{ id: socket.id, name: playerName, score: 0 }],
            gameState: 'lobby',
            mode: 'individual', 
            votes: {},          
            currentCase: null,
            isPrivate: isPrivate,
            password: roomPassword
        });

        socket.join(roomCode);
        
        // Host'a özel başarı mesajı
        socket.emit('room_created', { roomCode, isHost: true });
        
        // Listeyi güncelle
        io.emit('room_list_update', getPublicRoomList());
        
        // Oyuncu listesini güncelle
        io.to(roomCode).emit('update_player_list', rooms.get(roomCode).players);
    });

    // 2. ODAYA KATILMA
    socket.on('join_room', ({ roomCode, playerName, password }) => {
        const room = rooms.get(roomCode);

        if (!room) return socket.emit('error_message', '❌ Böyle bir oda bulunamadı!');
        if (room.gameState !== 'lobby') return socket.emit('error_message', '⚠️ Oyun çoktan başladı!');
        if (room.password && room.password !== password) return socket.emit('error_message', '🔒 Yanlış Şifre!');

        // İsim kontrolü
        const nameExists = room.players.some(p => p.name === playerName);
        if (nameExists) return socket.emit('error_message', '⚠️ Bu isim zaten odada var!');

        room.players.push({ id: socket.id, name: playerName, score: 0 });
        socket.join(roomCode);

        // Katılan kişiye "Başarılı" sinyali (BU ÇOK ÖNEMLİ)
        socket.emit('join_success', { roomCode, isHost: false });

        // Odadakilere güncel listeyi at
        io.to(roomCode).emit('update_player_list', room.players);
        
        // Genel listeyi güncelle (sayı arttı)
        io.emit('room_list_update', getPublicRoomList());
    });

    // 3. OYUNU BAŞLATMA
    socket.on('start_game', ({ roomCode, caseId, mode }) => {
        const room = rooms.get(roomCode);
        
        if (room && room.host === socket.id) {
            
            // 3 Kişi Kuralı
            if (mode === 'voting' && room.players.length < 3) {
                socket.emit('error_message', '⚠️ Demokrasi modu için en az 3 kişi gereklidir!');
                return;
            }

            room.gameState = 'playing';
            room.currentCase = caseId;
            room.mode = mode || 'individual';
            
            // Herkese başlat sinyali
            io.to(roomCode).emit('game_started', { caseId, mode: room.mode });
            
            // Oyun başladı, listeden kaldır
            io.emit('room_list_update', getPublicRoomList());
        }
    });

    // 4. OY KULLANMA
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
                if (counts[sceneId] > maxVotes) {
                    maxVotes = counts[sceneId];
                    winnerScene = sceneId;
                }
            });

            setTimeout(() => {
                room.votes = {}; 
                io.to(roomCode).emit('force_scene_change', winnerScene);
            }, 3000);
        }
    });

    // Manuel liste yenileme isteği
    socket.on('get_public_rooms', () => {
        socket.emit('room_list_update', getPublicRoomList());
    });

    socket.on('disconnect', () => {
        // Basitlik adına oyuncu düşürme eklemiyoruz,
        // çünkü array yönetimi karmaşıklaşabilir.
        console.log(`❌ Ayrıldı: ${socket.id}`);
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🚀 Sunucu çalışıyor`);
});
