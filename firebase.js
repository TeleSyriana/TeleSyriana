// firebase.js – TeleSyriana
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js";
import {
  getFirestore,
  doc,
  setDoc,
  getDoc,
  updateDoc,
  collection,
  query,
  where,
  orderBy,
  onSnapshot,
  serverTimestamp,
  addDoc,         
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

// نصدّر كل شيء نحتاجه
export const fs = {
  doc,
  setDoc,
  getDoc,
  updateDoc,
  collection,
  query,
  where,
  orderBy,
  onSnapshot,
  serverTimestamp,
  addDoc,   
};






