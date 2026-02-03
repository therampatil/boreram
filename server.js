const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Serve static files from public folder
app.use(express.static(path.join(__dirname, "public")));

// Track rooms and users with game state
const rooms = {};

// Game state structure for each room
// rooms[roomCode] = {
//   members: [{ id, name }],
//   players: { [socketId]: { name, x, worldY, distance, color, stunned } },
//   obstacles: [{ id, x, worldY, distance }],
//   nextObstacleId: 0,
//   lastSpawnWorldY: 0
// }

// Obstacle generation settings
const OBSTACLE_SPAWN_INTERVAL = 50; // meters between obstacles
const OBSTACLE_DESPAWN_DISTANCE = 100; // meters behind the last player
const SPAWN_AHEAD_DISTANCE = 300; // meters ahead of furthest player to spawn
const PIXELS_PER_METER = 2; // Must match client

// Dynamic difficulty settings
const BASE_ROAD_WIDTH = 200;
const MAX_ROAD_WIDTH = 400;
const ROAD_EXPANSION_INTERVAL = 30000; // 30 seconds
const ROAD_EXPANSION_RATE = 1.1; // 10% increase

const BASE_GAME_SPEED = 2;
const MAX_GAME_SPEED = 20; // Chaos mode speed
const SPEED_INCREMENT_PER_TICK = 0.0005;

// Colors for other players
const playerColors = [
  "#ff6b6b",
  "#4ecdc4",
  "#ffe66d",
  "#95e1d3",
  "#f38181",
  "#aa96da",
  "#fcbad3",
  "#a8d8ea",
];

function getPlayerColor(index) {
  return playerColors[index % playerColors.length];
}

io.on("connection", (socket) => {
  console.log("A user connected:", socket.id);

  // Handle join room request
  socket.on("join-room", (data) => {
    const { roomCode, name } = data;

    if (!roomCode || !name) {
      socket.emit("error", "Room code and name are required");
      return;
    }

    // Join the Socket.io room
    socket.join(roomCode);

    // Store user info
    socket.roomCode = roomCode;
    socket.userName = name;

    // Initialize room if needed
    if (!rooms[roomCode]) {
      rooms[roomCode] = {
        members: [],
        players: {},
        obstacles: [],
        nextObstacleId: 0,
        lastSpawnWorldY: 0, // Track spawning by world Y position
        furthestWorldY: 0, // Track the furthest player's worldY
        // Dynamic difficulty state
        roadWidth: BASE_ROAD_WIDTH,
        gameSpeed: BASE_GAME_SPEED,
        lastExpansionTime: Date.now(),
        createdAt: Date.now(),
      };
    }

    // Add to members list
    rooms[roomCode].members.push({ id: socket.id, name: name });

    // Initialize player game state
    const playerIndex = rooms[roomCode].members.length - 1;
    rooms[roomCode].players[socket.id] = {
      name: name,
      x: 0.5, // Normalized position (0-1, center of road)
      worldY: 0, // Absolute world Y position
      distance: 0,
      color: getPlayerColor(playerIndex),
      stunned: false,
      stunnedUntil: 0,
    };

    console.log(`User [${name}] joined Room [${roomCode}]`);

    // Notify the user they joined successfully
    socket.emit("joined", {
      roomCode: roomCode,
      name: name,
      members: rooms[roomCode].members,
      playerId: socket.id,
      playerColor: rooms[roomCode].players[socket.id].color,
    });

    // Notify others in the room
    socket.to(roomCode).emit("user-joined", {
      name: name,
      members: rooms[roomCode].members,
    });
  });

  // Handle player state updates from clients
  socket.on("player-update", (data) => {
    const roomCode = socket.roomCode;
    if (roomCode && rooms[roomCode] && rooms[roomCode].players[socket.id]) {
      const player = rooms[roomCode].players[socket.id];
      player.x = data.x;
      player.worldY = data.worldY !== undefined ? data.worldY : player.worldY;
      player.distance = data.distance;
      player.stunned = data.stunned || false;
    }
  });

  // Handle collision report from client
  socket.on("collision", () => {
    const roomCode = socket.roomCode;
    if (roomCode && rooms[roomCode] && rooms[roomCode].players[socket.id]) {
      const player = rooms[roomCode].players[socket.id];
      player.stunned = true;
      player.stunnedUntil = Date.now() + 2000; // 2 seconds stun
    }
  });

  // Handle disconnect
  socket.on("disconnect", () => {
    if (socket.roomCode && rooms[socket.roomCode]) {
      // Remove from members
      rooms[socket.roomCode].members = rooms[socket.roomCode].members.filter(
        (user) => user.id !== socket.id,
      );

      // Remove player state
      delete rooms[socket.roomCode].players[socket.id];

      console.log(`User [${socket.userName}] left Room [${socket.roomCode}]`);

      // Notify others in the room
      io.to(socket.roomCode).emit("user-left", {
        name: socket.userName,
        members: rooms[socket.roomCode].members,
      });

      // Clean up empty rooms
      if (rooms[socket.roomCode].members.length === 0) {
        delete rooms[socket.roomCode];
      }
    }
  });
});

// Game state broadcast loop - 30 TPS (ticks per second)
const TICK_RATE = 30;
setInterval(() => {
  const now = Date.now();

  for (const roomCode in rooms) {
    const room = rooms[roomCode];
    if (room.members.length > 0) {
      // Update stun states
      for (const playerId in room.players) {
        const player = room.players[playerId];
        if (player.stunned && now >= player.stunnedUntil) {
          player.stunned = false;
        }
      }

      // Dynamic difficulty: Increase game speed slowly each tick
      if (room.gameSpeed < MAX_GAME_SPEED) {
        room.gameSpeed += SPEED_INCREMENT_PER_TICK;
        room.gameSpeed = Math.min(room.gameSpeed, MAX_GAME_SPEED);
      }

      // Dynamic difficulty: Expand road every 30 seconds
      if (now - room.lastExpansionTime >= ROAD_EXPANSION_INTERVAL) {
        room.lastExpansionTime = now;
        const newWidth = room.roadWidth * ROAD_EXPANSION_RATE;
        room.roadWidth = Math.min(newWidth, MAX_ROAD_WIDTH);
        console.log(
          `Room [${roomCode}] road expanded to ${Math.floor(room.roadWidth)}px`,
        );
      }

      // Find player positions in world Y coordinates
      // worldY is negative and decreases (more negative) as players move forward
      // So: smaller worldY = further ahead, larger worldY = further behind
      let minWorldY = 0; // Most negative = furthest ahead (leader)
      let maxWorldY = 0; // Least negative = furthest behind
      let hasPlayers = false;

      for (const odplayerId in room.players) {
        const p = room.players[odplayerId];
        const wy = p.worldY || 0;

        if (!hasPlayers) {
          minWorldY = wy;
          maxWorldY = wy;
          hasPlayers = true;
        } else {
          if (wy < minWorldY) minWorldY = wy; // More negative = further ahead
          if (wy > maxWorldY) maxWorldY = wy; // Less negative = further behind
        }
      }

      // Generate new obstacles ahead of the leading player
      // Obstacles spawn at negative worldY values ahead of the leader
      const spawnAheadPixels = SPAWN_AHEAD_DISTANCE * PIXELS_PER_METER;
      const spawnIntervalPixels = OBSTACLE_SPAWN_INTERVAL * PIXELS_PER_METER;

      // Initialize spawn position if needed (start spawning ahead of current leader)
      if (room.lastSpawnWorldY === 0 && hasPlayers) {
        room.lastSpawnWorldY = minWorldY - spawnIntervalPixels;
      }

      // Spawn obstacles ahead of the leading player (minWorldY)
      // We need lastSpawnWorldY to be more negative than minWorldY - spawnAhead
      const spawnThreshold = minWorldY - spawnAheadPixels;
      while (room.lastSpawnWorldY > spawnThreshold) {
        room.lastSpawnWorldY -= spawnIntervalPixels;
        const newObstacle = {
          id: room.nextObstacleId++,
          x: Math.random() * 0.8 + 0.1, // Random position (10%-90% of road width)
          worldY: room.lastSpawnWorldY,
          distance: Math.abs(room.lastSpawnWorldY) / PIXELS_PER_METER, // For backwards compat
        };
        room.obstacles.push(newObstacle);
      }

      // Remove obstacles that are behind all players (worldY greater than maxWorldY + buffer)
      const despawnBufferPixels = OBSTACLE_DESPAWN_DISTANCE * PIXELS_PER_METER;
      room.obstacles = room.obstacles.filter(
        (obs) => obs.worldY < maxWorldY + despawnBufferPixels,
      );

      // Build leaderboard (top 5 by distance)
      const leaderboard = Object.entries(room.players)
        .map(([id, p]) => ({ name: p.name, distance: p.distance }))
        .sort((a, b) => b.distance - a.distance)
        .slice(0, 5);

      // Broadcast game state
      io.to(roomCode).emit("game-state", {
        players: room.players,
        obstacles: room.obstacles,
        leaderboard: leaderboard,
        roadWidth: room.roadWidth,
        gameSpeed: room.gameSpeed,
      });
    }
  }
}, 1000 / TICK_RATE);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
