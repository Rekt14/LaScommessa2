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

const suits = ["Denari", "Spade", "Bastoni", "Coppe"];
const values = [
    { n: "Asso", p: 11 }, { n: "Re", p: 10 }, { n: "Cavallo", p: 9 }, { n: "Fante", p: 8 },
    { n: "7", p: 7 }, { n: "6", p: 6 }, { n: "5", p: 5 }, { n: "4", p: 4 }, { n: "3", p: 3 }, { n: "2", p: 2 }
];
const suitOrder = { Denari: 4, Spade: 3, Bastoni: 2, Coppe: 1 };

const rooms = {};

function createDeck() {
    let deck = [];
    suits.forEach(s => values.forEach(v => deck.push({ suit: s, name: v.n, power: v.p })));
    return deck.sort(() => Math.random() - 0.5);
}

io.on('connection', (socket) => {
    socket.on('createRoom', (data) => {
        const roomId = Math.random().toString(36).substring(2, 7);
        rooms[roomId] = {
            id: roomId,
            creator: data.playerName,
            maxPlayers: data.maxPlayers,
            players: [{ id: socket.id, name: data.playerName, points: 0, tricksWon: 0, bet: null, ready: false }],
            status: 'waiting',
            currentRound: 1,
            currentTrick: [],
            turnIndex: 0,
            tricksInRound: 0
        };
        socket.join(roomId);
        socket.emit('roomCreated', rooms[roomId]);
        io.emit('updateRoomList', Object.values(rooms).filter(r => r.status === 'waiting'));
    });

    socket.on('joinRoom', (data) => {
        const room = rooms[data.roomId];
        if (room && room.players.length < room.maxPlayers) {
            room.players.push({ id: socket.id, name: data.playerName, points: 0, tricksWon: 0, bet: null, ready: false });
            socket.join(data.roomId);
            if (room.players.length == room.maxPlayers) {
                room.status = 'playing';
                io.to(room.id).emit('startGame', room);
                startNewRound(room);
            }
            io.emit('updateRoomList', Object.values(rooms).filter(r => r.status === 'waiting'));
        }
    });

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

    socket.on('readyForNextRound', ({ roomId }) => {
        const room = rooms[roomId];
        if (!room) return;
        const player = room.players.find(p => p.id === socket.id);
        player.ready = true;
        if (room.players.every(p => p.ready)) {
            room.currentRound++;
            room.players.forEach(p => p.ready = false);
            startNewRound(room);
        }
    });

    socket.on('disconnect', () => {
    for (const roomId in rooms) {
        const room = rooms[roomId];
        const playerIndex = room.players.findIndex(p => p.id === socket.id);

        if (playerIndex !== -1) {
            const disconnectedPlayer = room.players[playerIndex];
            // Avvisa gli altri nella stanza
            io.to(roomId).emit('playerDisconnected', { name: disconnectedPlayer.name });
            
            // Elimina la stanza per liberare memoria
            delete rooms[roomId];
            
            // Aggiorna la lista stanze globale per chi è ancora in lobby
            io.emit('updateRoomList', Object.values(rooms).filter(r => r.status === 'waiting'));
            break; 
        }
    }
});

function startNewRound(room) {
    const deck = createDeck();
    room.currentTrick = [];
    room.tricksInRound = 0;
    room.players.forEach(p => { 
        p.bet = null; 
        p.tricksWon = 0; 
        // Assegniamo la mano all'oggetto player nel server
        p.hand = deck.splice(0, room.currentRound); 
    });

    room.players.forEach(p => {
        // Prepariamo i dati degli avversari da inviare
        const opponentsData = room.players.map(opp => ({
            id: opp.id,
            name: opp.name,
            // Al Round 1 inviamo la carta in chiaro, altrimenti la nascondiamo
            hand: (room.currentRound === 1) ? opp.hand : null 
        }));

        io.to(p.id).emit('yourHand', { 
            hand: p.hand, 
            round: room.currentRound,
            opponents: opponentsData // Nuova proprietà
        });
    });
}

function resolveTrick(room) {
    let winner = room.currentTrick[0];
    for (let i = 1; i < room.currentTrick.length; i++) {
        const cur = room.currentTrick[i];
        if (cur.card.power > winner.card.power || (cur.card.power === winner.card.power && suitOrder[cur.card.suit] > suitOrder[winner.card.suit])) {
            winner = cur;
        }
    }
    const winningPlayer = room.players.find(p => p.id === winner.owner);
    winningPlayer.tricksWon++;
    room.turnIndex = room.players.findIndex(p => p.id === winner.owner);
    room.tricksInRound++;

    setTimeout(() => {
        io.to(room.id).emit('trickResolved', { winnerId: winner.owner, players: room.players });
        room.currentTrick = [];
        if (room.tricksInRound === room.currentRound) {
            endRound(room);
        } else {
            io.to(room.players[room.turnIndex].id).emit('yourTurn');
        }
    }, 2000);
}

function endRound(room) {
    room.players.forEach(p => {
        const gained = (p.tricksWon === p.bet) ? (10 + p.bet) : -Math.abs(p.bet - p.tricksWon);
        p.points += gained;
    });
    io.to(room.id).emit('roundEnded', { players: room.players, nextRound: room.currentRound + 1 });
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server pronto sulla porta ${PORT}`));
