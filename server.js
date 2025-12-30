const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const cors = require('cors');
const path = require('path');

// Uygulama Kurulumu
const app = express();
app.use(cors());
app.use(express.static(path.join(__dirname, 'public'))); // 'public' klasörünü dışa aç

const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*", methods: ["GET", "POST"] }
});

// --- OYUN DURUMU (RAM Bellek - Faz 1 için) ---
// Not: İleride burası Upstash Redis ile değiştirilecek.
const rooms = new Map(); 

// --- GÜVENLİ ODA KODU ALGORİTMASI (Base-21) ---
// Sesli harfler (A, E, I, O, U) ve karışanlar (0, 1, L) yok.
function generateRoomCode() {
    const chars = "BCDFGHJKMNPQRSTVWXYZ23456789";
    let code = "";
    for (let i = 0; i < 4; i++) {
        code += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return code;
}

// --- SOCKET.IO OLAYLARI ---
io.on('connection', (socket) => {
    console.log(`🔌 Yeni bağlantı: ${socket.id}`);

    // 1. Oda Oluşturma
    socket.on('create_room', (playerName) => {
        let roomCode = generateRoomCode();
        
        // Çakışma kontrolü
        while(rooms.has(roomCode)) {
            roomCode = generateRoomCode();
        }

        // Oda verisini oluştur
        rooms.set(roomCode, {
            host: socket.id,
            players: [{ id: socket.id, name: playerName, score: 0 }],
            gameState: 'lobby', // lobby, playing, voting, ended
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

        // Oyuncuyu odaya ekle
        room.players.push({ id: socket.id, name: playerName, score: 0 });
        socket.join(roomCode);

        // Odadaki herkese (kendisi dahil) güncel listeyi gönder
        io.to(roomCode).emit('update_player_list', room.players);
        console.log(`👤 ${playerName} odaya katıldı: ${roomCode}`);
    });

    // 3. Oyunu Başlatma (Sadece Host)
    socket.on('start_game', ({ roomCode, caseId }) => {
        const room = rooms.get(roomCode);
        if (room && room.host === socket.id) {
            room.gameState = 'playing';
            room.currentCase = caseId;
            // Herkese oyunu başlat sinyali gönder
            io.to(roomCode).emit('game_started', { caseId });
        }
    });

    // Bağlantı Kopması
    socket.on('disconnect', () => {
        console.log(`❌ Ayrıldı: ${socket.id}`);
        // (Buraya ileride oda temizleme mantığı eklenecek)
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🚀 Sunucu çalışıyor: http://localhost:${PORT}`);
});