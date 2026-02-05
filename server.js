const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors());
const server = http.createServer(app);
const io = new Server(server, { 
    cors: { origin: "*", methods: ["GET", "POST"] } 
});

// --- CONFIGURAZIONE GIOCO ---
const suits = ["Denari", "Spade", "Bastoni", "Coppe"];
const values = [
    { n: "Asso", p: 11 }, { n: "Re", p: 10 }, { n: "Cavallo", p: 9 }, { n: "Fante", p: 8 },
    { n: "7", p: 7 }, { n: "6", p: 6 }, { n: "5", p: 5 }, { n: "4", p: 4 }, { n: "3", p: 3 }, { n: "2", p: 2 }
];
const suitOrder = { Denari: 4, Spade: 3, Bastoni: 2, Coppe: 1 };

const rooms = {};

// --- UTILS ---
function createDeck() {
    let deck = [];
    suits.forEach(s => values.forEach(v => deck.push({ suit: s, name: v.n, power: v.p })));
    return deck.sort(() => Math.random() - 0.5);
}

// --- LOGICA SERVER ---
io.on('connection', (socket) => {
    console.log('Connesso:', socket.id);

    // Creazione Stanza
    socket.on('createRoom', (data) => {
        const roomId = Math.random().toString(36).substring(2, 7);
        rooms[roomId] = {
            id: roomId,
            creator: data.playerName,
            maxPlayers: data.maxPlayers,
            players: [{ id: socket.id, name: data.playerName, points: 0, tricksWon: 0, bet: null }],
            status: 'waiting',
            currentRound: 1,
            currentTrick: [],
            turnIndex: 0
        };
        socket.join(roomId);
        socket.emit('roomCreated', rooms[roomId]);
        io.emit('updateRoomList', Object.values(rooms).filter(r => r.status === 'waiting'));
    });

    // Unione Stanza
    socket.on('joinRoom', (data) => {
        const room = rooms[data.roomId];
        if (room && room.players.length < room.maxPlayers) {
            room.players.push({ id: socket.id, name: data.playerName, points: 0, tricksWon: 0, bet: null });
            socket.join(data.roomId);
            
            if (room.players.length == room.maxPlayers) {
                room.status = 'playing';
                io.to(room.id).emit('startGame', room);
                startNewRound(room);
            }
            io.emit('updateRoomList', Object.values(rooms).filter(r => r.status === 'waiting'));
        }
    });

    // Gestione Scommesse
    socket.on('placeBet', ({ roomId, bet }) => {
        const room = rooms[roomId];
        if (!room) return;
        const player = room.players.find(p => p.id === socket.id);
        player.bet = bet;

        if (room.players.every(p => p.bet !== null)) {
            io.to(roomId).emit('betsConfirmed', room.players);
            io.to(room.players[room.turnIndex].id).emit('yourTurn');
        }
    });

    // Gestione Giocata Carta
    socket.on('playCard', ({ roomId, card }) => {
        const room = rooms[roomId];
        if (!room) return;

        room.currentTrick.push({ owner: socket.id, card });
        io.to(roomId).emit('cardPlayed', { owner: socket.id, card });

        if (room.currentTrick.length === room.players.length) {
            resolveTrick(room);
        } else {
            room.turnIndex = (room.turnIndex + 1) % room.players.length;
            io.to(room.players[room.turnIndex].id).emit('yourTurn');
        }
    });

    socket.on('disconnect', () => {
        // Opzionale: gestire la chiusura stanza se il creatore esce
        console.log('Disconnesso:', socket.id);
    });
});

// --- FUNZIONI DI GIOCO ---
function startNewRound(room) {
    const deck = createDeck();
    room.currentTrick = [];
    room.players.forEach(p => { p.bet = null; p.tricksWon = 0; });
    
    room.players.forEach(p => {
        const hand = deck.splice(0, room.currentRound);
        io.to(p.id).emit('yourHand', { hand, round: room.currentRound });
    });
}

function resolveTrick(room) {
    let winner = room.currentTrick[0];
    for (let i = 1; i < room.currentTrick.length; i++) {
        const current = room.currentTrick[i];
        if (current.card.power > winner.card.power || 
           (current.card.power === winner.card.power && suitOrder[current.card.suit] > suitOrder[winner.card.suit])) {
            winner = current;
        }
    }

    const winningPlayer = room.players.find(p => p.id === winner.owner);
    winningPlayer.tricksWon++;
    
    // Chi vince la mano inizia la prossima
    room.turnIndex = room.players.findIndex(p => p.id === winner.owner);
    
    setTimeout(() => {
        io.to(room.id).emit('trickResolved', { 
            winnerId: winner.owner, 
            players: room.players,
            lastTrick: room.currentTrick 
        });
        room.currentTrick = [];

        // Qui potremmo aggiungere il controllo fine round
    }, 2000);
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server pronto sulla porta ${PORT}`));
