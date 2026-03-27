import { useEffect, useMemo, useState } from "react";

const API_URL =
  import.meta.env.VITE_API_URL ||
  import.meta.env.NEXT_PUBLIC_API_URL ||
  "http://localhost:4000";

function useApi(token) {
  return useMemo(() => {
    return async function api(path, options = {}) {
      const headers = {
        "Content-Type": "application/json",
        ...(options.headers || {}),
      };

      if (token) {
        headers.Authorization = `Bearer ${token}`;
      }

      const res = await fetch(`${API_URL}${path}`, {
        ...options,
        headers,
      });

      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.error || "request failed");
      }
      return data;
    };
  }, [token]);
}

export default function App() {
  const [mode, setMode] = useState("login");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [token, setToken] = useState(localStorage.getItem("token") || "");
  const [rooms, setRooms] = useState([]);
  const [activeRoomId, setActiveRoomId] = useState(null);
  const [newRoomName, setNewRoomName] = useState("");
  const [messages, setMessages] = useState([]);
  const [messageInput, setMessageInput] = useState("");
  const [error, setError] = useState("");
  const [info, setInfo] = useState("");

  const api = useApi(token);

  async function loadRooms() {
    try {
      const data = await api("/rooms");
      setRooms(data);
      if (!activeRoomId && data.length) {
        setActiveRoomId(data[0].id);
      }
    } catch (e) {
      setError(e.message);
    }
  }

  async function loadMessages(roomId) {
    if (!roomId) {
      setMessages([]);
      return;
    }

    try {
      const data = await api(`/rooms/${roomId}/messages`);
      setMessages(data);
    } catch (e) {
      setMessages([]);
      setError(e.message);
    }
  }

  useEffect(() => {
    if (!token) {
      return;
    }
    setError("");
    loadRooms();
  }, [token]);

  useEffect(() => {
    if (!token || !activeRoomId) {
      return;
    }

    loadMessages(activeRoomId);

    const timer = setInterval(() => {
      loadMessages(activeRoomId);
    }, 2000);

    return () => clearInterval(timer);
  }, [token, activeRoomId]);

  async function handleAuthSubmit(event) {
    event.preventDefault();
    setError("");
    setInfo("");

    try {
      if (mode === "register") {
        await api("/auth/register", {
          method: "POST",
          body: JSON.stringify({ username, password }),
        });
        setInfo("註冊成功，請直接登入");
        setMode("login");
        return;
      }

      const data = await api("/auth/login", {
        method: "POST",
        body: JSON.stringify({ username, password }),
      });

      localStorage.setItem("token", data.token);
      setToken(data.token);
      setInfo(`登入成功：${data.user.username}`);
    } catch (e) {
      setError(e.message);
    }
  }

  async function handleCreateRoom(event) {
    event.preventDefault();
    setError("");

    try {
      const room = await api("/rooms", {
        method: "POST",
        body: JSON.stringify({ name: newRoomName }),
      });

      await api(`/rooms/${room.id}/join`, { method: "POST" });
      setNewRoomName("");
      setActiveRoomId(room.id);
      await loadRooms();
      await loadMessages(room.id);
    } catch (e) {
      setError(e.message);
    }
  }

  async function handleJoinRoom(roomId) {
    setError("");
    try {
      await api(`/rooms/${roomId}/join`, { method: "POST" });
      setActiveRoomId(roomId);
      await loadMessages(roomId);
    } catch (e) {
      setError(e.message);
    }
  }

  async function handleSendMessage(event) {
    event.preventDefault();
    if (!activeRoomId) {
      return;
    }

    try {
      await api(`/rooms/${activeRoomId}/messages`, {
        method: "POST",
        body: JSON.stringify({ content: messageInput }),
      });
      setMessageInput("");
      await loadMessages(activeRoomId);
    } catch (e) {
      setError(e.message);
    }
  }

  function handleLogout() {
    localStorage.removeItem("token");
    setToken("");
    setRooms([]);
    setMessages([]);
    setActiveRoomId(null);
    setInfo("已登出");
  }

  if (!token) {
    return (
      <main className="auth-shell">
        <section className="auth-card">
          <h1>DB Chat 測試 APP</h1>
          <p>常見 use case: 註冊、登入、建立房間、加入房間、發送訊息、讀取歷史訊息</p>

          <form onSubmit={handleAuthSubmit}>
            <label>
              Username
              <input
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder="alice"
                required
              />
            </label>

            <label>
              Password
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="至少 6 碼"
                required
              />
            </label>

            <button type="submit">{mode === "register" ? "註冊" : "登入"}</button>
          </form>

          <div className="switcher">
            <button
              className={mode === "login" ? "active" : ""}
              onClick={() => setMode("login")}
            >
              我有帳號
            </button>
            <button
              className={mode === "register" ? "active" : ""}
              onClick={() => setMode("register")}
            >
              建立新帳號
            </button>
          </div>

          {info ? <p className="info">{info}</p> : null}
          {error ? <p className="error">{error}</p> : null}
        </section>
      </main>
    );
  }

  return (
    <main className="chat-layout">
      <aside>
        <div className="aside-head">
          <h2>聊天室</h2>
          <button onClick={handleLogout}>登出</button>
        </div>

        <form className="new-room" onSubmit={handleCreateRoom}>
          <input
            value={newRoomName}
            onChange={(e) => setNewRoomName(e.target.value)}
            placeholder="新房間名稱"
            required
          />
          <button type="submit">建立</button>
        </form>

        <ul className="room-list">
          {rooms.map((room) => (
            <li key={room.id}>
              <button
                className={activeRoomId === room.id ? "active" : ""}
                onClick={() => handleJoinRoom(room.id)}
              >
                #{room.name}
              </button>
            </li>
          ))}
        </ul>
      </aside>

      <section className="chat-panel">
        <h2>
          {activeRoomId
            ? `Room #${rooms.find((r) => r.id === activeRoomId)?.name || activeRoomId}`
            : "請先選擇房間"}
        </h2>

        <div className="messages">
          {messages.map((msg) => (
            <article key={msg.id}>
              <header>
                <strong>{msg.username}</strong>
                <time>{new Date(msg.created_at).toLocaleString()}</time>
              </header>
              <p>{msg.content}</p>
            </article>
          ))}
        </div>

        <form className="composer" onSubmit={handleSendMessage}>
          <input
            value={messageInput}
            onChange={(e) => setMessageInput(e.target.value)}
            placeholder="輸入訊息"
            required
          />
          <button type="submit">送出</button>
        </form>

        {error ? <p className="error">{error}</p> : null}
        {info ? <p className="info">{info}</p> : null}
      </section>
    </main>
  );
}
