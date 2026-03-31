import app from './app.js';
import { assertConfig, config } from './config/index.js';
import { createServer } from 'http';
import { Server } from 'socket.io';

assertConfig();

const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: { origin: '*' }
});

io.on('connection', (socket) => {
  console.log('Socket connected:', socket.id);

  socket.on('join-call', (callId) => {
    socket.join(callId);
    console.log(`Socket ${socket.id} joined call room ${callId}`);
    socket.to(callId).emit('user-joined', { socketId: socket.id });
  });

  socket.on('receiver-ready', (data) => {
    socket.to(data.callId).emit('receiver-ready', { callId: data.callId });
  });

  socket.on('offer', (data) => {
    socket.to(data.callId).emit('offer', {
      offer: data.offer,
      fromSocket: socket.id
    });
  });

  socket.on('answer', (data) => {
    socket.to(data.callId).emit('answer', {
      answer: data.answer,
      fromSocket: socket.id
    });
  });

  socket.on('ice-candidate', (data) => {
    socket.to(data.callId).emit('ice-candidate', {
      candidate: data.candidate,
      fromSocket: socket.id
    });
  });

  socket.on('end-call', (data) => {
    socket.to(data.callId).emit('call-ended');
  });

  socket.on('disconnect', () => {
    console.log('Socket disconnected:', socket.id);
  });
});

app.set('io', io);

httpServer.listen(config.port, () => {
  console.log(`Emergency Alert API listening on http://localhost:${config.port}`);
});
