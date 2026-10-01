const { initializeApp } = require('firebase/app');
const {
  getFirestore,
  doc,
  getDoc,
  collection,
  getDocs,
  query,
  where,
  orderBy,
  limit,
} = require('firebase/firestore');

// Firebase configuration (project: seds-pakistan)
const firebaseConfig = {
  apiKey: "AIzaSyDpKUqoo-OZHTXSrkPj1HiCQwZWE7CyeIg",
  authDomain: "seds-pakistan.firebaseapp.com",
  projectId: "seds-pakistan",
  storageBucket: "seds-pakistan.firebasestorage.app",
  messagingSenderId: "884993774057",
  appId: "1:884993774057:web:50eb3cd3917dc61045fb78",
  measurementId: "G-HJ0LZD8K4B",
};

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);

async function run() {
  try {
    console.log('🔎 Reading pages/about...');
    const aboutSnap = await getDoc(doc(db, 'pages', 'about'));
    if (aboutSnap.exists()) {
      const about = aboutSnap.data();
      console.log(`✅ About title: ${about.title}`);
      console.log(`   Sections: ${Array.isArray(about.sections) ? about.sections.length : 0}`);
    } else {
      console.log('⚠️ pages/about is missing');
    }

    console.log('\n🔎 Listing teamMembers (order asc, limit 10)...');
    const teamSnap = await getDocs(query(collection(db, 'teamMembers'), orderBy('order', 'asc'), limit(10)));
    console.log(`✅ Team members: ${teamSnap.size}`);
    teamSnap.forEach((d) => {
      const data = d.data();
      console.log(` - ${d.id}: ${data.name} (${data.role}) [active=${data.isActive}]`);
    });

    console.log('\n🔎 Listing roleHistory for role=President (order by startDate desc, limit 5)...');
    const histSnap = await getDocs(
      query(
        collection(db, 'roleHistory'),
        where('role', '==', 'President'),
        orderBy('startDate', 'desc'),
        limit(5)
      )
    );
    console.log(`✅ Role history docs: ${histSnap.size}`);
    histSnap.forEach((d) => {
      const data = d.data();
      const start = data.startDate && typeof data.startDate.toDate === 'function' ? data.startDate.toDate().toISOString().slice(0, 10) : String(data.startDate);
      const end = data.endDate && typeof data.endDate.toDate === 'function' ? data.endDate.toDate().toISOString().slice(0, 10) : data.endDate ? String(data.endDate) : 'current';
      console.log(` - ${d.id}: ${data.person} (${data.role}) ${start} → ${end}`);
    });

    console.log('\n🎉 Public read checks completed successfully');
    process.exit(0);
  } catch (error) {
    console.error('\n❌ Public read check failed:', error);
    process.exit(1);
  }
}

run();