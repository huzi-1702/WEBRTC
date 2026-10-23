const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));

io.on('connection', (socket) => {
  socket.on('join', (room) => {
    const members = io.sockets.adapter.rooms.get(room);
    const count = members ? members.size : 0;
    if (count >= 2) return socket.emit('full');
    socket.join(room);
    // Người vào sau báo cho người vào trước để bắt đầu tạo offer
    if (count === 1) socket.to(room).emit('peer-joined');
  });

  ['offer', 'answer', 'ice-candidate'].forEach((evt) => {
    socket.on(evt, (data) => socket.to(data.room).emit(evt, data));
  });
});

server.listen(3000, () => console.log('http://localhost:3000'));