const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const cors = require('cors');

// Uygulama Kurulumu
const app = express();
app.use(cors());

const server = http.createServer(app);

// CORS ayarı: Tüm sitelerden gelen bağlantıyı kabul et
const io = new Server(server, {
    cors: { origin: "*", methods: ["GET", "POST"] }
});

// OYUN DURUMU (RAM Bellek)
const rooms = new Map();

// --- ODA KODU ALGORİTMASI ---
function generateRoomCode() {
    const chars = "BCDFGHJKMNPQRSTVWXYZ23456789";
    let code = "";
    for (let i = 0; i < 4; i++) {
        code += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return code;
}

io.on('connection', (socket) => {
    console.log(`🔌 Yeni bağlantı: ${socket.id}`);

    // 1. Oda Oluşturma
    socket.on('create_room', (playerName) => {
        let roomCode = generateRoomCode();
        while(rooms.has(roomCode)) {
            roomCode = generateRoomCode();
        }

        // Oda verisini oluştur
        rooms.set(roomCode, {
            host: socket.id,
            players: [{ id: socket.id, name: playerName, score: 0 }],
            gameState: 'lobby',
            mode: 'individual', // Varsayılan mod
            votes: {},          // Oyları tutacak
            currentCase: null
        });

        socket.join(roomCode);
        socket.emit('room_created', { roomCode, isHost: true });
        console.log(`🏠 Oda kuruldu: ${roomCode} (Host: ${playerName})`);
    });

    // 2. Odaya Katılma
    socket.on('join_room', ({ roomCode, playerName }) => {
        const room = rooms.get(roomCode);

        if (!room) {
            socket.emit('error_message', '❌ Böyle bir oda bulunamadı!');
            return;
        }

        if (room.gameState !== 'lobby') {
            socket.emit('error_message', '⚠️ Oyun çoktan başladı!');
            return;
        }

        room.players.push({ id: socket.id, name: playerName, score: 0 });
        socket.join(roomCode);

        io.to(roomCode).emit('update_player_list', room.players);
        console.log(`👤 ${playerName} odaya katıldı: ${roomCode}`);
    });

    // 3. Oyunu Başlatma (Host Mod Seçer)
    socket.on('start_game', ({ roomCode, caseId, mode }) => {
        const room = rooms.get(roomCode);
        if (room && room.host === socket.id) {
            room.gameState = 'playing';
            room.currentCase = caseId;
            room.mode = mode || 'individual'; // individual veya voting
            
            // Herkese oyunu başlat sinyali (Mod bilgisiyle)
            io.to(roomCode).emit('game_started', { caseId, mode: room.mode });
            console.log(`🎬 Oyun başladı: ${roomCode}, Mod: ${room.mode}`);
        }
    });

    // 4. OY KULLANMA (Demokrasi Modu İçin)
    socket.on('cast_vote', ({ roomCode, nextSceneId }) => {
        const room = rooms.get(roomCode);
        
        // Güvenlik kontrolleri
        if (!room || room.mode !== 'voting') return;
        
        // Oyuncunun oyunu kaydet (Önceki oyunu ezer)
        room.votes[socket.id] = nextSceneId;
        
        const playerCount = room.players.length;
        const voteCount = Object.keys(room.votes).length;

        console.log(`🗳️ Oy kullanıldı (${roomCode}): ${voteCount}/${playerCount}`);

        // Herkese "Biri oy kullandı" bilgisini gönder
        io.to(roomCode).emit('vote_update', { voteCount, total: playerCount });

        // HERKES OY VERDİ Mİ?
        if (voteCount >= playerCount) {
            // Oyları say
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

            // Oyları sıfırla
            room.votes = {};
            
            // Herkesi kazanan sahneye zorla götür
            io.to(roomCode).emit('force_scene_change', winnerScene);
            console.log(`✅ Oylama bitti. Kazanan sahne: ${winnerScene}`);
        }
    });

    // Bağlantı Kopması
    socket.on('disconnect', () => {
        console.log(`❌ Ayrıldı: ${socket.id}`);
        // Not: Gerçek bir uygulamada odadan oyuncuyu silmek gerekir.
        // Şimdilik basit tutuyoruz.
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🚀 Sunucu çalışıyor: http://localhost:${PORT}`);
});
