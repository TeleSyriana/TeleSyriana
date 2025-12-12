// messages.js — Simple team chat (Messenger-style) for TeleSyriana

import { db, fs } from "./firebase.js";

const { collection, doc, setDoc, query, orderBy, onSnapshot, serverTimestamp } = fs;

const USER_KEY = "telesyrianaUser";
const CHAT_COL = "chatMessages";

let currentUser = null;
let unsubChat = null;

document.addEventListener("DOMContentLoaded", () => {
  // 1) استرجاع المستخدم الحالي من localStorage
  const raw = localStorage.getItem(USER_KEY);
  if (raw) {
    try {
      currentUser = JSON.parse(raw);
    } catch {
      currentUser = null;
    }
  }

  // 2) عناصر الشات من HTML
  const chatList = document.getElementById("chat-messages");
  const chatForm = document.getElementById("chat-form");
  const chatInput = document.getElementById("chat-input");

  // لو ما في عناصر شات، لا تفعل شيء
  if (!chatList || !chatForm || !chatInput) return;

  // 3) إرسال رسالة
  chatForm.addEventListener("submit", async (e) => {
    e.preventDefault();

    const text = chatInput.value.trim();
    if (!text) return;

    if (!currentUser) {
      alert("Please login to send messages.");
      return;
    }

    try {
      // بنستخدم setDoc + doc(collection(...)) بدال addDoc
      const msgRef = doc(collection(db, CHAT_COL));
      await setDoc(msgRef, {
        text,
        userId: currentUser.id,
        userName: currentUser.name,
        role: currentUser.role,
        createdAt: serverTimestamp(),
      });

      chatInput.value = "";
    } catch (err) {
      console.error("Send message error:", err);
      alert("Could not send message. Please try again.");
    }
  });

  // 4) الاشتراك بالرسائل (real-time)
  const q = query(
    collection(db, CHAT_COL),
    orderBy("createdAt", "asc")
  );

  unsubChat = onSnapshot(
    q,
    (snapshot) => {
      chatList.innerHTML = "";

      snapshot.forEach((docSnap) => {
        const msg = docSnap.data();

        const wrapper = document.createElement("div");
        // لو الرسالة من نفس الموظف الحالي → حط لها كلاس me
        const isMe = currentUser && msg.userId === currentUser.id;
        wrapper.className = "chat-message" + (isMe ? " me" : "");

        // اسم المرسل
        const nameEl = document.createElement("div");
        nameEl.className = "chat-name";
        nameEl.textContent = msg.userName || msg.userId || "Unknown";

        // البابل (نص الرسالة)
        const bubble = document.createElement("div");
        bubble.className = "chat-bubble";
        bubble.textContent = msg.text || "";

        // الوقت تحت صغير
        const meta = document.createElement("div");
        meta.className = "chat-meta";

        if (msg.createdAt && msg.createdAt.toDate) {
          const d = msg.createdAt.toDate();
          meta.textContent = d.toLocaleTimeString([], {
            hour: "2-digit",
            minute: "2-digit",
          });
        } else {
          meta.textContent = "";
        }

        wrapper.appendChild(nameEl);
        wrapper.appendChild(bubble);
        wrapper.appendChild(meta);

        chatList.appendChild(wrapper);
      });

      // Scroll لآخر رسالة
      chatList.scrollTop = chatList.scrollHeight;
    },
    (err) => {
      console.error("Chat snapshot error:", err);
    }
  );
});
