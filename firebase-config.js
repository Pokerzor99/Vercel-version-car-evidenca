const firebaseConfig = {
  apiKey: "AIzaSyBDXn6C3KtGn5R6DDa-7_omysaiLVoSr4Y",
  authDomain: "evidenca-vozil-59bb9.firebaseapp.com",
  projectId: "evidenca-vozil-59bb9",
  storageBucket: "evidenca-vozil-59bb9.firebasestorage.app",
  messagingSenderId: "427492066139",
  appId: "1:427492066139:web:bf4983277ce147089fd07e"
};

firebase.initializeApp(firebaseConfig);
window.__carMaintenanceDb = firebase.firestore();
window.__carMaintenanceStorage = firebase.storage();
