const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { createClient } = require('@libsql/client');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(__dirname));

const GAS_WEBAPP_URL = process.env.GAS_WEBAPP_URL || "https://script.google.com/macros/s/AKfycbwYsl3issVM1SgFyeuRVCITmIfex6kc7lmuiRXVpxbD195ctM0aAsyUxBV_NZxVz9UH/exec";
const db = createClient({
    url: process.env.TURSO_DATABASE_URL || "libsql://senninchat-senninch.aws-ap-northeast-1.turso.io",
    authToken: process.env.TURSO_AUTH_TOKEN || "eyJhbGciOiJFZERTQSIsInR5cCI6IkpXVCJ9.eyJhIjoicnciLCJpYXQiOjE3Nzk4ODU4MzIsImlkIjoiMDE5ZTY5NTgtZTcwMS03NzhmLWFkYjAtMGQzMzM5ZDdlMDBlIiwicmlkIjoiZGU3ZTdlNTktYjZmMi00YWQ4LWIwNDMtYzkyMmY4ZDE2NGVkIn0.ER5t8rLt3YMoOWBv03igSfFH_z_O7JkdxedTLOOxv6HZ0SqiUa2Ef_Kre1qN0paLbTUkEpqlxlA5UrSSDvJkCA"
});

async function initDB() {
    await db.execute(`
        CREATE TABLE IF NOT EXISTS users (
            user_id TEXT PRIMARY KEY,
            username TEXT NOT NULL UNIQUE
        )
    `);
    await db.execute(`
        CREATE TABLE IF NOT EXISTS friends (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id TEXT NOT NULL,
            friend_id TEXT NOT NULL,
            UNIQUE(user_id, friend_id)
        )
    `);
    await db.execute(`
        CREATE TABLE IF NOT EXISTS groups (
            group_id TEXT PRIMARY KEY,
            group_name TEXT NOT NULL
        )
    `);
    await db.execute(`
        CREATE TABLE IF NOT EXISTS group_members (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            group_id TEXT NOT NULL,
            user_id TEXT NOT NULL,
            UNIQUE(group_id, user_id)
        )
    `);
    await db.execute(`
        CREATE TABLE IF NOT EXISTS messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            channel TEXT NOT NULL,
            name TEXT NOT NULL,
            avatar TEXT NOT NULL,
            color TEXT NOT NULL,
            text TEXT NOT NULL,
            timestamp TEXT NOT NULL,
            reply_id INTEGER DEFAULT NULL,
            reply_text TEXT DEFAULT NULL
        )
    `);
}

app.post('/api/login', async (req, res) => {
    const { username, password } = req.body;
    try {
        const fetch = (await import('node-fetch')).default;
        const gasRes = await fetch(`${GAS_WEBAPP_URL}?action=login&username=${encodeURIComponent(username)}&password=${encodeURIComponent(password)}`, {
            method: 'POST'
        });
        const result = await gasRes.json();

        if (result.success) {
            await db.execute({
                sql: "INSERT OR IGNORE INTO users (user_id, username) VALUES (?, ?)",
                args: [result.userId, result.username]
            });
        }
        res.json(result);
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

app.post('/api/register', async (req, res) => {
    const { username, password } = req.body;
    try {
        const fetch = (await import('node-fetch')).default;
        const gasRes = await fetch(`${GAS_WEBAPP_URL}?action=register&username=${encodeURIComponent(username)}&password=${encodeURIComponent(password)}`, {
            method: 'POST'
        });
        const result = await gasRes.json();

        if (result.success) {
            await db.execute({
                sql: "INSERT OR IGNORE INTO users (user_id, username) VALUES (?, ?)",
                args: [result.userId, result.username]
            });
        }
        res.json(result);
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

app.post('/api/friends/add', async (req, res) => {
    const { userId, friendId } = req.body;
    if (!userId || !friendId) {
        return res.json({ success: false, message: "ユーザーIDまたはフレンドIDが不足しています。" });
    }
    if (userId === friendId) {
        return res.json({ success: false, message: "自分自身をフレンドに追加することはできません。" });
    }
    try {
        const userCheck = await db.execute({
            sql: "SELECT username FROM users WHERE user_id = ?",
            args: [friendId]
        });
        if (userCheck.rows.length === 0) {
            return res.json({ success: false, message: "該当する固有IDのユーザーがチャットシステムに見つかりません。" });
        }

        await db.execute({
            sql: "INSERT OR IGNORE INTO friends (user_id, friend_id) VALUES (?, ?)",
            args: [userId, friendId]
        });

        await db.execute({
            sql: "INSERT OR IGNORE INTO friends (user_id, friend_id) VALUES (?, ?)",
            args: [friendId, userId]
        });

        res.json({ success: true, message: `フレンド「${userCheck.rows[0].username}」とお互いにフレンドになりました。` });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

app.get('/api/friends', async (req, res) => {
    const { userId } = req.query;
    try {
        const result = await db.execute({
            sql: "SELECT u.user_id, u.username FROM friends f JOIN users u ON f.friend_id = u.user_id WHERE f.user_id = ?",
            args: [userId]
        });
        res.json({ success: true, friends: result.rows });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

app.post('/api/groups/create', async (req, res) => {
    const { groupName, userId } = req.body;
    if (!groupName || !userId) {
        return res.json({ success: false, message: "グループ名またはユーザーIDが不足しています。" });
    }
    const crypto = require('crypto');
    const groupId = 'group_' + crypto.randomBytes(8).toString('hex');
    try {
        await db.execute({
            sql: "INSERT INTO groups (group_id, group_name) VALUES (?, ?)",
            args: [groupId, groupName]
        });
        await db.execute({
            sql: "INSERT INTO group_members (group_id, user_id) VALUES (?, ?)",
            args: [groupId, userId]
        });
        res.json({ success: true, message: `グループ「${groupName}」を作成しました。` });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

app.post('/api/groups/invite', async (req, res) => {
    const { groupId, friendId } = req.body;
    if (!groupId || !friendId) {
        return res.json({ success: false, message: "グループIDまたはフレンドIDが不足しています。" });
    }
    try {
        await db.execute({
            sql: "INSERT OR IGNORE INTO group_members (group_id, user_id) VALUES (?, ?)",
            args: [groupId, friendId]
        });
        res.json({ success: true, message: "グループにフレンドを招待しました。" });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

app.get('/api/groups', async (req, res) => {
    const { userId } = req.query;
    try {
        const result = await db.execute({
            sql: "SELECT g.group_id, g.group_name FROM group_members gm JOIN groups g ON gm.group_id = g.group_id WHERE gm.user_id = ?",
            args: [userId]
        });
        res.json({ success: true, groups: result.rows });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

io.on('connection', (socket) => {
    socket.on('join_channel', async (data) => {
        const { myId, friendId, isGroup, groupId } = data;
        let roomId = '';

        if (isGroup) {
            roomId = groupId;
        } else {
            if (!myId || !friendId) return;
            roomId = [myId, friendId].sort().join('_');
        }

        socket.join(roomId);

        try {
            const result = await db.execute({
                sql: "SELECT * FROM messages WHERE channel = ? ORDER BY id ASC LIMIT 100",
                args: [roomId]
            });
            socket.emit('load_history', result.rows);
        } catch (err) {
            console.error("データ取得失敗:", err);
        }
    });

    socket.on('send_message', async (msgData) => {
        const { channel, name, avatar, color, text, timestamp, replyId, replyText } = msgData;

        try {
            const res = await db.execute({
                sql: "INSERT INTO messages (channel, name, avatar, color, text, timestamp, reply_id, reply_text) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                args: [channel, name, avatar, color, text, timestamp, replyId || null, replyText || null]
            });

            const insertedId = res.lastInsertRowid !== undefined ? Number(res.lastInsertRowid) : null;

            io.to(channel).emit('receive_message', {
                id: insertedId,
                channel: channel,
                name: name,
                avatar: avatar,
                color: color,
                text: text,
                timestamp: timestamp,
                reply_id: replyId || null,
                reply_text: replyText || null
            });
        } catch (err) {
            console.error("データ保存失敗:", err);
        }
    });

    socket.on('delete_message', async (data) => {
        const { msgId, roomId } = data;
        try {
            await db.execute({
                sql: "DELETE FROM messages WHERE id = ?",
                args: [msgId]
            });
            io.to(roomId).emit('message_deleted', { msgId: msgId, roomId: roomId });
        } catch (err) {
            console.error("データ削除失敗:", err);
        }
    });
});

const PORT = process.env.PORT || 3000;

async function startServer() {
    try {
        await initDB();
        server.listen(PORT, () => {
            console.log(`Server is running on http://localhost:${PORT}`);
        });
    } catch (err) {
        console.error("データベース初期化エラーによりサーバーを起動できませんでした:", err);
    }
}

startServer();
