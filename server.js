const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.static('public')); // Statik dosyaları sunmak için

const server = http.createServer(app);

const io = new Server(server, {
    cors: { origin: "*", methods: ["GET", "POST"] }
});

const rooms = new Map();
const scenesCache = {}; // Senaryoları bellekte tutmak için

// Senaryo Dosyalarını Yükle (Sunucu tarafında)
function loadCaseData(caseId) {
    if (scenesCache[caseId]) return scenesCache[caseId];
    try {
        // Dosya yolunu projenize göre ayarlayın
        const dataPath = path.join(__dirname, 'data', `scenes${caseId.replace('case', '')}.json`);
        const rawData = fs.readFileSync(dataPath);
        const jsonData = JSON.parse(rawData);
        scenesCache[caseId] = jsonData;
        return jsonData;
    } catch (err) {
        console.error(`Senaryo yükleme hatası (${caseId}):`, err);
        return null;
    }
}

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

    // ODA OLUŞTURMA
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
            currentSceneId: 'giris', // Herkes aynı sahnede başlar
            isPrivate: (visibility === 'private'),
            password: (visibility === 'protected' && password) ? password : null,
            hintCount: 3
        });

        socket.join(roomCode);
        socket.emit('room_created', { roomCode, isHost: true });
        io.emit('room_list_update', getPublicRoomList());
        io.to(roomCode).emit('update_player_list', rooms.get(roomCode).players);
        
        // Sistem Mesajı (Güvenli)
        io.to(roomCode).emit('chat_message', { 
            sender: 'Sistem', 
            text: `Oda kuruldu. Dedektif ${playerName} giriş yaptı.`, 
            type: 'system' 
        });
    });

    // ODAYA KATILMA
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

    // GÜVENLİ CHAT (XSS Önlenmiş hali client'ta render edilecek)
    socket.on('send_chat', ({ roomCode, message, playerName, avatar }) => {
        // Basit sunucu tarafı validasyon
        if (!message || message.trim().length === 0) return;
        const safeMessage = message.substring(0, 500); // Karakter limiti

        io.to(roomCode).emit('chat_message', { 
            sender: playerName, 
            text: safeMessage, 
            avatar: avatar,
            id: socket.id,
            type: 'user'
        });
    });

    socket.on('typing', ({ roomCode, playerName, isTyping }) => {
        socket.to(roomCode).emit('user_typing', { playerName, isTyping });
    });

    // OYUNU BAŞLATMA
    socket.on('start_game', ({ roomCode, caseId, mode }) => {
        const room = rooms.get(roomCode);
        if (room && room.host === socket.id) {
            const caseData = loadCaseData(caseId);
            if (!caseData) return socket.emit('error_message', 'Senaryo dosyası sunucuda bulunamadı!');

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

            // İlk sahneyi gönder (SENARYO VERİSİ SUNUCUDAN GİDER)
            sendSceneToRoom(roomCode, 'giris');
            
            io.emit('room_list_update', getPublicRoomList());
        }
    });

    // OYUNCU SEÇİM YAPTIĞINDA (Artık istemci doğrudan loadScene yapmaz)
    socket.on('make_choice', ({ roomCode, nextSceneId }) => {
        const room = rooms.get(roomCode);
        if (!room) return;

        // Bireysel modda her oyuncu farklı yerde olabilir (Bunun için logic karmaşıktır, 
        // MVP için herkesin senkronize hareket ettiğini veya istemciye sadece veri attığımızı varsayalım.
        // Güvenlik için: İstemci "Ben X seçtim" der, sunucu "Tamam, X sahnesinin verisi bu" der.)
        
        if (room.mode === 'individual') {
            sendSceneToSocket(socket, room.currentCaseId, nextSceneId);
        } else if (room.mode === 'voting') {
            // Oylama modu mantığı...
             handleVoting(socket, roomCode, nextSceneId);
        }
    });

    // Oylama Modu Fonksiyonu
    function handleVoting(socket, roomCode, nextSceneId) {
        const room = rooms.get(roomCode);
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
            // En çok oy alanı bul
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

    // İpucu İsteği
    socket.on('request_hint', ({ roomCode, playerName }) => {
        const room = rooms.get(roomCode);
        if (!room) return;
        
        // Oylama modunda ipucu sayısı ortaktır
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
             // Bireysel modda oyuncunun kendi hint'i istemcide tutulabilir veya
             // sunucu sadece metni döner.
             // Basitlik için veriyi gönderelim:
             // (Gerçek bir projede bireysel state'ler de sunucuda tutulmalı)
        }
    });
    
    // Yardımcı: Tek bir oyuncuya sahne verisi gönder
    function sendSceneToSocket(socket, caseId, sceneId) {
        const sceneData = getSceneData(caseId, sceneId);
        if (sceneData) {
            socket.emit('scene_data', sceneData);
        }
    }

    // Yardımcı: Tüm odaya sahne verisi gönder
    function sendSceneToRoom(roomCode, sceneId) {
        const room = rooms.get(roomCode);
        const sceneData = getSceneData(room.currentCaseId, sceneId);
        if (sceneData) {
            io.to(roomCode).emit('scene_data', sceneData);
        }
    }

    // Senaryo içinden sahne bulma
    function getSceneData(caseId, sceneId) {
        const caseJson = loadCaseData(caseId);
        if (!caseJson || !caseJson.scenes) return null;
        return caseJson.scenes.find(s => s.scene_id === sceneId);
    }

    socket.on('get_public_rooms', () => { socket.emit('room_list_update', getPublicRoomList()); });

    socket.on('disconnect', () => {
        rooms.forEach((room, code) => {
            const playerIndex = room.players.findIndex(p => p.id === socket.id);
            if (playerIndex !== -1) {
                const pName = room.players[playerIndex].name;
                room.players.splice(playerIndex, 1); 
                io.to(code).emit('update_player_list', room.players);
                io.to(code).emit('chat_message', { sender: 'Sistem', text: `${pName} ayrıldı.`, type: 'leave' });
                
                // Oda boşaldıysa sil
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
