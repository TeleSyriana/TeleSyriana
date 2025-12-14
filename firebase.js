// import { initializeApp } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js";
// import {
//   getFirestore,

//   // docs
//   doc,
//   setDoc,
//   getDoc,
//   updateDoc,
//   deleteDoc,

//   // collections / queries
//   collection,
//   addDoc,
//   getDocs,
//   query,
//   where,
//   orderBy,
//   onSnapshot,
//   serverTimestamp,

//   // optional helpers (nice to have)
//   limit,
//   startAfter
// } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";

// const firebaseConfig = {
//   apiKey: "AIzaSyDSvgD5GEZRE_zBzspoPr3pHQW1XOZr6yQ",
//   authDomain: "telesyriana-ccms.firebaseapp.com",
//   projectId: "telesyriana-ccms",
//   storageBucket: "telesyriana-ccms.appspot.com",
//   messagingSenderId: "867008812270",
//   appId: "1:867008812270:web:b87edde8d675aa5e224fff",
// };

// export const app = initializeApp(firebaseConfig);
// export const db = getFirestore(app);

// // keep same pattern used in your project
// export const fs = {
//   // docs
//   doc,
//   setDoc,
//   getDoc,
//   updateDoc,
//   deleteDoc,

//   // collections / queries
//   collection,
//   addDoc,
//   getDocs,
//   query,
//   where,
//   orderBy,
//   onSnapshot,
//   serverTimestamp,

//   // optional
//   limit,
//   startAfter
// };

// firebase.js – TeleSyriana (FINAL / complete for messages + meetings + tasks)

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js";
import {
  getFirestore,

  // docs
  doc,
  setDoc,
  getDoc,
  updateDoc,
  deleteDoc,

  // collections / reads
  collection,
  addDoc,
  getDocs,

  // queries
  query,
  where,
  orderBy,
  limit,
  startAfter,
  onSnapshot,

  // timestamps / server helpers
  serverTimestamp,
  Timestamp,

  // ✅ IMPORTANT (for sequential meeting IDs)
  runTransaction,
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";

const firebaseConfig = {
  apiKey: "AIzaSyDSvgD5GEZRE_zBzspoPr3pHQW1XOZr6yQ",
  authDomain: "telesyriana-ccms.firebaseapp.com",
  projectId: "telesyriana-ccms",
  storageBucket: "telesyriana-ccms.appspot.com",
  messagingSenderId: "867008812270",
  appId: "1:867008812270:web:b87edde8d675aa5e224fff",
};

export const app = initializeApp(firebaseConfig);
export const db = getFirestore(app);

// Keep same pattern used in your project
export const fs = {
  // docs
  doc,
  setDoc,
  getDoc,
  updateDoc,
  deleteDoc,

  // collections / reads
  collection,
  addDoc,
  getDocs,

  // queries
  query,
  where,
  orderBy,
  limit,
  startAfter,
  onSnapshot,

  // timestamps / server helpers
  serverTimestamp,
  Timestamp,

  // ✅ transactions
  runTransaction,
};



