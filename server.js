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

// --- 各種設定（環境に合わせて書き換えてください） ---
const GAS_WEBAPP_URL = process.env.GAS_WEBAPP_URL || "https://script.google.com/macros/s/AKfycbwYsl3issVM1SgFyeuRVCITmIfex6kc7lmuiRXVpxbD195ctM0aAsyUxBV_NZxVz9UH/exec";
const db = createClient({
    url: process.env.TURSO_DATABASE_URL || "libsql://senninchat-senninch.aws-ap-northeast-1.turso.io",
    authToken: process.env.TURSO_AUTH_TOKEN || "eyJhbGciOiJFZERTQSIsInR5cCI6IkpXVCJ9.eyJhIjoicnciLCJpYXQiOjE3Nzk4ODU4MzIsImlkIjoiMDE5ZTY5NTgtZTcwMS03NzhmLWFkYjAtMGQzMzM5ZDdlMDBlIiwicmlkIjoiZGU3ZTdlNTktYjZmMi00YWQ4LWIwNDMtYzkyMmY4ZDE2NGVkIn0.ER5t8rLt3YMoOWBv03igSfFH_z_O7JkdxedTLOOxv6HZ0SqiUa2Ef_Kre1qN0paLbTUkEpqlxlA5UrSSDvJkCA"
});

// データベースの初期化
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
        CREATE TABLE IF NOT EXISTS messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            channel TEXT NOT NULL,
            name TEXT NOT NULL,
            avatar TEXT NOT NULL,
            color TEXT NOT NULL,
            text TEXT NOT NULL,
            timestamp TEXT NOT NULL
        )
    `);
}
initDB().catch(console.error);

// --- アカウントサービスAPI (GAS連携) ---

// 1. ログイン処理
app.post('/api/login', async (req, res) => {
    const { username, password } = req.body;
    try {
        const fetch = (await import('node-fetch')).default;
        const gasRes = await fetch(`${GAS_WEBAPP_URL}?action=login&username=${encodeURIComponent(username)}&password=${encodeURIComponent(password)}`, {
            method: 'POST'
        });
        const result = await gasRes.json();

        if (result.success) {
            // 認証成功時、Turso側にユーザー情報を同期保存（存在しなければ挿入）
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

// 2. 新規登録処理
app.post('/api/register', async (req, res) => {
    const { username, password } = req.body;
    try {
        const fetch = (await import('node-fetch')).default;
        const gasRes = await fetch(`${GAS_WEBAPP_URL}?action=register&username=${encodeURIComponent(username)}&password=${encodeURIComponent(password)}`, {
            method: 'POST'
        });
        const result = await gasRes.json();

        if (result.success) {
            // 登録成功時、Turso側にユーザー情報を同期保存
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

// 3. フレンド追加処理 (userId を使用 - お互いに登録されるように修正)
app.post('/api/friends/add', async (req, res) => {
    const { userId, friendId } = req.body;
    if (!userId || !friendId) {
        return res.json({ success: false, message: "ユーザーIDまたはフレンドIDが不足しています。" });
    }
    if (userId === friendId) {
        return res.json({ success: false, message: "自分自身をフレンドに追加することはできません。" });
    }
    try {
        // 追加対象のフレンドがTursoのユーザーリストに存在するかチェック
        const userCheck = await db.execute({
            sql: "SELECT username FROM users WHERE user_id = ?",
            args: [friendId]
        });
        if (userCheck.rows.length === 0) {
            return res.json({ success: false, message: "該当する固有IDのユーザーがチャットシステムに見つかりません。" });
        }

        // 自分から相手へのフレンド関係を保存
        await db.execute({
            sql: "INSERT OR IGNORE INTO friends (user_id, friend_id) VALUES (?, ?)",
            args: [userId, friendId]
        });

        // 相手から自分へのフレンド関係も同時に保存（お互いにフレンド化）
        await db.execute({
            sql: "INSERT OR IGNORE INTO friends (user_id, friend_id) VALUES (?, ?)",
            args: [friendId, userId]
        });

        res.json({ success: true, message: `フレンド「${userCheck.rows[0].username}」とお互いにフレンドになりました。` });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

// 4. フレンド一覧取得処理
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


// --- Socket.io リアルタイム通信ロジック ---
io.on('connection', (socket) => {
    socket.on('join_channel', async (data) => {
        const { myId, friendId } = data;
        if (!myId || !friendId) return;

        // 2人のユーザーIDを並び替えて共通のルームIDを決定
        const roomId = [myId, friendId].sort().join('_');
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
        const { myId, friendId, name, avatar, color, text, timestamp } = msgData;
        if (!myId || !friendId) return;

        // 保存用・通信用に共通のルームIDを決定
        const roomId = [myId, friendId].sort().join('_');

        try {
            await db.execute({
                sql: "INSERT INTO messages (channel, name, avatar, color, text, timestamp) VALUES (?, ?, ?, ?, ?, ?)",
                args: [roomId, name, avatar, color, text, timestamp]
            });

            io.to(roomId).emit('receive_message', {
                channel: roomId,
                name: name,
                avatar: avatar,
                color: color,
                text: text,
                timestamp: timestamp
            });
        } catch (err) {
            console.error("データ保存失敗:", err);
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`);
});
