const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const MAX_PEERS = 4; // mesh: nhiều hơn 4-5 người sẽ rất nặng
const ROOM_RE = /^[a-zA-Z0-9_-]{1,32}$/;

app.use(express.static(path.join(__dirname, '..', 'public')));

io.on('connection', (socket) => {
  socket.on('join', (room) => {
  if (typeof room !== 'string' || !ROOM_RE.test(room)) return socket.emit('invalid-room');
    const members = io.sockets.adapter.rooms.get(room);
    const others = members ? [...members] : [];
    if (others.length >= MAX_PEERS) return socket.emit('full');

    socket.join(room);
    socket.data.room = room;
    // Báo cho người mới biết ai đang ở trong phòng, người mới sẽ tạo offer
    socket.emit('room-users', others);
    console.log(`[${room}] ${socket.id} vào phòng (${others.length + 1} người)`);
  });

  // Chuyển tiếp tin nhắn signaling tới đúng một người nhận
  ['offer', 'answer', 'ice-candidate'].forEach((evt) => {
    socket.on(evt, (data) => {
      if (!data || !data.to) return;
      const target = io.sockets.sockets.get(data.to);
      // Chỉ cho phép gửi cho người cùng phòng
      if (!target || target.data.room !== socket.data.room) return;
      io.to(data.to).emit(evt, { ...data, from: socket.id });
    });
  });

  socket.on('disconnect', () => {
    const room = socket.data.room;
    if (room) {
      socket.to(room).emit('peer-left', socket.id);
      console.log(`[${room}] ${socket.id} rời phòng`);
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`http://localhost:${PORT}`));