const WebSocket = require('ws');
const { v4: uuidv4 } = require('uuid');
const http = require('http');

const PORT = process.env.PORT || 8080;

// HTTP сервер нужен для Render/Railway (health check)
const httpServer = http.createServer((req, res) => {
  if (req.url === '/health' || req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'online',
      rooms: rooms.size,
      connections: wss.clients.size,
      uptime: Math.floor(process.uptime())
    }));
  } else {
    res.writeHead(404);
    res.end('Not found');
  }
});

const wss = new WebSocket.Server({ server: httpServer });
const rooms = new Map();

const COLORS = [
  '#FF6B6B', '#4ECDC4', '#45B7D1', '#96CEB4',
  '#FFEAA7', '#DDA0DD', '#98D8C8', '#F7DC6F',
  '#BB8FCE', '#85C1E9', '#F8C471', '#82E0AA',
  '#F0B27A', '#AED6F1', '#A3E4D7', '#FAD7A0'
];
let colorIndex = 0;

function getNextColor() {
  const color = COLORS[colorIndex % COLORS.length];
  colorIndex++;
  return color;
}

function broadcast(room, message, excludeWs = null) {
  const data = typeof message === 'string' ? message : JSON.stringify(message);
  room.clients.forEach((userInfo, client) => {
    if (client !== excludeWs && client.readyState === WebSocket.OPEN) {
      try { client.send(data); } catch (e) {}
    }
  });
}

function getUserList(room) {
  const users = [];
  room.clients.forEach((info) => {
    users.push({ username: info.username, color: info.color });
  });
  return users;
}

function removeClientFromRoom(ws) {
  for (const [roomId, room] of rooms) {
    if (room.clients.has(ws)) {
      const userInfo = room.clients.get(ws);
      room.clients.delete(ws);

      console.log(`[${roomId}] ${userInfo.username} left`);

      broadcast(room, {
        type: 'user_left',
        username: userInfo.username,
        users: getUserList(room)
      });

      if (room.clients.size === 0) {
        rooms.delete(roomId);
        console.log(`[${roomId}] Room deleted`);
      } else if (room.host === ws) {
        const first = room.clients.keys().next().value;
        room.host = first;
        const hostInfo = room.clients.get(first);
        broadcast(room, {
          type: 'new_host',
          username: hostInfo.username
        });
      }
      return;
    }
  }
}

wss.on('connection', (ws) => {
  console.log('New connection, total:', wss.clients.size);

  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch (e) { return; }

    switch (msg.type) {

      case 'create_room': {
        // Удаляем из старой комнаты
        removeClientFromRoom(ws);

        const roomId = uuidv4().substring(0, 6).toUpperCase();
        const username = (msg.username || 'Host').substring(0, 20);
        const color = getNextColor();

        const room = {
          id: roomId,
          host: ws,
          clients: new Map(),
          createdAt: Date.now()
        };
        room.clients.set(ws, { username, color });
        rooms.set(roomId, room);

        ws.send(JSON.stringify({
          type: 'room_created',
          roomId, username, color,
          users: getUserList(room)
        }));

        console.log(`[${roomId}] Created by ${username}`);
        break;
      }

      case 'join_room': {
        removeClientFromRoom(ws);

        const roomId = (msg.roomId || '').toUpperCase().trim();
        const room = rooms.get(roomId);

        if (!room) {
          ws.send(JSON.stringify({ type: 'error', message: 'Room "' + roomId + '" not found' }));
          return;
        }
        if (room.clients.size >= 10) {
          ws.send(JSON.stringify({ type: 'error', message: 'Room is full (max 10)' }));
          return;
        }

        let username = (msg.username || 'Guest').substring(0, 20);
        const names = new Set();
        room.clients.forEach(i => names.add(i.username));
        let n = 1;
        let base = username;
        while (names.has(username)) { username = base + '_' + n; n++; }

        const color = getNextColor();
        room.clients.set(ws, { username, color });

        ws.send(JSON.stringify({
          type: 'room_joined',
          roomId, username, color,
          users: getUserList(room)
        }));

        broadcast(room, {
          type: 'user_joined',
          username, color,
          users: getUserList(room)
        }, ws);

        // Просим хоста прислать модель
        if (room.host && room.host.readyState === WebSocket.OPEN) {
          room.host.send(JSON.stringify({
            type: 'request_full_state',
            targetUser: username
          }));
        }

        console.log(`[${roomId}] ${username} joined (${room.clients.size} users)`);
        break;
      }

      case 'full_state': {
        const room = rooms.get((msg.roomId || '').toUpperCase());
        if (!room) return;
        room.clients.forEach((info, client) => {
          if (info.username === msg.targetUser && client.readyState === WebSocket.OPEN) {
            try {
              client.send(JSON.stringify({
                type: 'full_state',
                projectData: msg.projectData
              }));
            } catch (e) {}
          }
        });
        break;
      }

      case 'model_action': {
        const room = rooms.get((msg.roomId || '').toUpperCase());
        if (!room) return;
        broadcast(room, {
          type: 'model_action',
          action: msg.action,
          username: msg.username,
          data: msg.data
        }, ws);
        break;
      }

      case 'texture_update': {
        const room = rooms.get((msg.roomId || '').toUpperCase());
        if (!room) return;
        broadcast(room, {
          type: 'texture_update',
          username: msg.username,
          textureUuid: msg.textureUuid,
          dataUrl: msg.dataUrl
        }, ws);
        break;
      }

      case 'chat_message': {
        const room = rooms.get((msg.roomId || '').toUpperCase());
        if (!room) return;
        const text = (msg.message || '').substring(0, 500);
        broadcast(room, {
          type: 'chat_message',
          username: msg.username,
          message: text,
          timestamp: Date.now()
        });
        break;
      }

      case 'cursor_update': {
        const room = rooms.get((msg.roomId || '').toUpperCase());
        if (!room) return;
        broadcast(room, {
          type: 'cursor_update',
          username: msg.username,
          color: msg.color,
          selectedElement: msg.selectedElement
        }, ws);
        break;
      }

      case 'leave_room': {
        removeClientFromRoom(ws);
        ws.send(JSON.stringify({ type: 'left_room' }));
        break;
      }

      case 'ping': {
        ws.send(JSON.stringify({ type: 'pong' }));
        break;
      }
    }
  });

  ws.on('close', () => {
    removeClientFromRoom(ws);
  });

  ws.on('error', () => {
    removeClientFromRoom(ws);
  });
});

// Heartbeat
setInterval(() => {
  wss.clients.forEach(ws => {
    if (!ws.isAlive) { removeClientFromRoom(ws); return ws.terminate(); }
    ws.isAlive = false;
    ws.ping();
  });
}, 30000);

// Очистка старых пустых комнат
setInterval(() => {
  const now = Date.now();
  rooms.forEach((room, id) => {
    if (room.clients.size === 0 || now - room.createdAt > 24 * 60 * 60 * 1000) {
      rooms.delete(id);
    }
  });
}, 60000);

httpServer.listen(PORT, () => {
  console.log(`Collab server running on port ${PORT}`);
});
