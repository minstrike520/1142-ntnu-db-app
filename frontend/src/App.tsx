import { useState, useEffect, useRef } from "react";
import io, { Socket } from "socket.io-client";
import axios from "axios";

// 動態取得前端目前使用的 hostname，並預設掛載在 :4000 的 backend
const host = window.location.hostname;
const API_URL = import.meta.env.VITE_API_URL || `http://${host}:4000`;

let socket: Socket | null = null;

function App() {
  const [token, setToken] = useState<string | null>(localStorage.getItem("token"));
  const [user, setUser] = useState<{ id: number; username: string } | null>(
    JSON.parse(localStorage.getItem("user") || "null")
  );

  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [isLogin, setIsLogin] = useState(true);

  const [rooms, setRooms] = useState<any[]>([]);
  const [currentRoom, setCurrentRoom] = useState<any | null>(null);

  const [messages, setMessages] = useState<any[]>([]);
  const [newMessage, setNewMessage] = useState("");
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Authentication
  const handleAuth = async (e: React.FormEvent) => {
    e.preventDefault();
    const endpoint = isLogin ? "/auth/login" : "/auth/register";
    try {
      const { data } = await axios.post(`${API_URL}${endpoint}`, { username, password });
      setToken(data.token);
      setUser(data.user);
      localStorage.setItem("token", data.token);
      localStorage.setItem("user", JSON.stringify(data.user));
      setUsername("");
      setPassword("");
    } catch (err: any) {
      alert(err.response?.data?.error || "Auth Failed");
    }
  };

  const logout = () => {
    setToken(null);
    setUser(null);
    setCurrentRoom(null);
    localStorage.removeItem("token");
    localStorage.removeItem("user");
    if (socket) socket.disconnect();
  };

  // Fetch Rooms
  const fetchRooms = async () => {
    try {
      const { data } = await axios.get(`${API_URL}/rooms`);
      setRooms(data);
    } catch (error) {
      console.error(error);
    }
  };

  const createRoom = async (name: string) => {
    if (!name.trim()) return;
    try {
      await axios.post(`${API_URL}/rooms`, { name });
      fetchRooms();
    } catch (error) {
      console.error(error);
    }
  };

  // Socket and Room init
  useEffect(() => {
    if (token && user) {
      socket = io(API_URL, {
        auth: { token },
      });

      fetchRooms();

      socket.on("new_message", (message) => {
        setMessages((prev) => [...prev, message]);
      });

      return () => {
        socket?.disconnect();
      };
    }
  }, [token, user]);

  // Join Room
  useEffect(() => {
    if (currentRoom && socket) {
      // Fetch history
      axios.get(`${API_URL}/rooms/${currentRoom.id}/messages`).then(({ data }) => {
        setMessages(data);
      });

      socket.emit("join_room", currentRoom.id);
    }
  }, [currentRoom]);

  // Scroll to bottom
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const sendMessage = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newMessage.trim() || !socket || !currentRoom) return;

    socket.emit("send_message", {
      roomId: currentRoom.id,
      content: newMessage,
    });
    setNewMessage("");
  };

  if (!token) {
    return (
      <div className="flex h-screen items-center justify-center bg-gray-100">
        <div className="w-full max-w-md bg-white p-8 shadow rounded">
          <h2 className="text-2xl font-bold mb-6 text-center">{isLogin ? "Login" : "Register"}</h2>
          <form onSubmit={handleAuth} className="space-y-4">
            <input
              type="text"
              placeholder="Username"
              className="w-full p-2 border border-gray-300 rounded"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              required
            />
            <input
              type="password"
              placeholder="Password"
              className="w-full p-2 border border-gray-300 rounded"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
            <button className="w-full bg-blue-500 text-white p-2 rounded hover:bg-blue-600">
              {isLogin ? "Login" : "Register"}
            </button>
          </form>
          <div className="mt-4 text-center">
            <button
              onClick={() => setIsLogin(!isLogin)}
              className="text-blue-500 hover:underline text-sm"
            >
              {isLogin ? "Need an account? Register" : "Already have an account? Login"}
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-screen bg-gray-100">
      {/* Sidebar / Rooms */}
      <div className="w-1/4 bg-white border-r border-gray-200 flex flex-col">
        <div className="p-4 border-b border-gray-200 flex justify-between items-center">
          <span className="font-bold text-lg">Hi, {user?.username}</span>
          <button onClick={logout} className="text-sm text-red-500 hover:underline">
            Logout
          </button>
        </div>
        
        <div className="p-4 flex flex-col flex-1 overflow-y-auto">
          <h3 className="font-bold text-gray-500 mb-2 uppercase text-sm">Channels</h3>
          <ul className="space-y-1">
            {rooms.map((room) => (
              <li key={room.id}>
                <button
                  onClick={() => setCurrentRoom(room)}
                  className={`w-full text-left p-2 rounded ${
                    currentRoom?.id === room.id ? "bg-blue-100 text-blue-700 font-bold" : "hover:bg-gray-100"
                  }`}
                >
                  # {room.name}
                </button>
              </li>
            ))}
          </ul>
        </div>
        
        <div className="p-4 border-t border-gray-200">
          <button
            onClick={() => {
              const name = prompt("Enter room name:");
              if (name) createRoom(name);
            }}
            className="w-full bg-gray-100 text-gray-700 p-2 rounded hover:bg-gray-200 text-sm"
          >
            + New Room
          </button>
        </div>
      </div>

      {/* Chat Area */}
      <div className="flex-1 flex flex-col bg-gray-50">
        {currentRoom ? (
          <>
            <div className="p-4 bg-white border-b border-gray-200 shadow-sm z-10">
              <h2 className="text-xl font-bold"># {currentRoom.name}</h2>
            </div>
            
            <div className="flex-1 p-4 overflow-y-auto flex flex-col space-y-4">
              {messages.map((msg, i) => (
                <div
                  key={i}
                  className={`flex flex-col ${
                    msg.user?.username === user?.username ? "items-end" : "items-start"
                  }`}
                >
                  <span className="text-xs text-gray-400 mb-1">{msg.user?.username}</span>
                  <div
                    className={`max-w-xs md:max-w-md p-3 rounded-lg shadow-sm ${
                      msg.user?.username === user?.username
                        ? "bg-blue-500 text-white"
                        : "bg-white text-gray-800 border border-gray-200"
                    }`}
                  >
                    {msg.content}
                  </div>
                </div>
              ))}
              <div ref={messagesEndRef} />
            </div>

            <div className="p-4 bg-white border-t border-gray-200">
              <form onSubmit={sendMessage} className="flex space-x-2">
                <input
                  type="text"
                  className="flex-1 p-2 border border-gray-300 rounded focus:outline-none focus:border-blue-500"
                  placeholder={`Message #${currentRoom.name}`}
                  value={newMessage}
                  onChange={(e) => setNewMessage(e.target.value)}
                />
                <button
                  type="submit"
                  className="bg-blue-500 text-white px-4 py-2 rounded hover:bg-blue-600 font-bold"
                >
                  Send
                </button>
              </form>
            </div>
          </>
        ) : (
          <div className="flex-1 flex items-center justify-center text-gray-400">
            Select or create a channel to start chatting
          </div>
        )}
      </div>
    </div>
  );
}

export default App;