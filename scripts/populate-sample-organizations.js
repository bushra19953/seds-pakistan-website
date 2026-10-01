// Sample Organizations for Credibility Marquee
// This script populates the organizations collection with demo data

const { initializeApp } = require('firebase/app');
const { getFirestore, collection, addDoc, getDocs, query, where, deleteDoc, doc } = require('firebase/firestore');
const admin = require('firebase-admin');

// Initialize Firebase Admin SDK
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.applicationDefault(),
  });
}

const db = admin.firestore();

const sampleOrganizations = [
  // National SEDS Chapters (Chapters)
  {
    name: "SEDS USA",
    type: "National Chapter",
    logoUrl: "https://flagcdn.com/w320/us.png",
    websiteUrl: "https://sedsusa.org",
    showOnHomepageMarquee: true,
    displayOrder: 1,
    isActive: true,
    description: "Students for the Exploration and Development of Space - USA"
  },
  {
    name: "UKSEDS", 
    type: "National Chapter",
    logoUrl: "https://flagcdn.com/w320/gb.png",
    websiteUrl: "https://ukseds.org",
    showOnHomepageMarquee: true,
    displayOrder: 2,
    isActive: true,
    description: "UK Students for the Exploration and Development of Space"
  },
  {
    name: "SEDS India",
    type: "National Chapter", 
    logoUrl: "https://flagcdn.com/w320/in.png",
    websiteUrl: "https://sedsindia.org",
    showOnHomepageMarquee: true,
    displayOrder: 3,
    isActive: true,
    description: "Students for the Exploration and Development of Space - India"
  },
  {
    name: "SEDS Germany",
    type: "National Chapter",
    logoUrl: "https://flagcdn.com/w320/de.png", 
    websiteUrl: "https://seds-germany.org",
    showOnHomepageMarquee: true,
    displayOrder: 4,
    isActive: true,
    description: "Students for the Exploration and Development of Space - Germany"
  },
  {
    name: "SEDS Brazil",
    type: "National Chapter",
    logoUrl: "https://flagcdn.com/w320/br.png",
    websiteUrl: "https://sedsbrasil.org", 
    showOnHomepageMarquee: true,
    displayOrder: 5,
    isActive: true,
    description: "Students for the Exploration and Development of Space - Brazil"
  },
  {
    name: "SEDS Canada",
    type: "National Chapter",
    logoUrl: "https://flagcdn.com/w320/ca.png",
    websiteUrl: "https://seds.ca",
    showOnHomepageMarquee: true,
    displayOrder: 6,
    isActive: true,
    description: "Students for the Exploration and Development of Space - Canada"
  },
  {
    name: "SEDS Japan", 
    type: "National Chapter",
    logoUrl: "https://flagcdn.com/w320/jp.png",
    websiteUrl: "https://seds-japan.org",
    showOnHomepageMarquee: true,
    displayOrder: 7,
    isActive: true,
    description: "Students for the Exploration and Development of Space - Japan"
  },

  // Institutional Partners (Partners)
  {
    name: "NASA",
    type: "Institutional Partner",
    logoUrl: "https://upload.wikimedia.org/wikipedia/commons/thumb/e/e5/NASA_logo.svg/320px-NASA_logo.svg.png",
    websiteUrl: "https://www.nasa.gov",
    showOnHomepageMarquee: true,
    displayOrder: 1,
    isActive: true,
    description: "National Aeronautics and Space Administration"
  },
  {
    name: "SpaceX",
    type: "Institutional Partner", 
    logoUrl: "https://upload.wikimedia.org/wikipedia/commons/thumb/d/de/SpaceX-Logo.svg/320px-SpaceX-Logo.svg.png",
    websiteUrl: "https://www.spacex.com",
    showOnHomepageMarquee: true,
    displayOrder: 2,
    isActive: true,
    description: "Space Exploration Technologies Corp"
  },
  {
    name: "ESA",
    type: "Institutional Partner",
    logoUrl: "https://upload.wikimedia.org/wikipedia/commons/thumb/7/7f/ESA_logo.svg/320px-ESA_logo.svg.png", 
    websiteUrl: "https://www.esa.int",
    showOnHomepageMarquee: true,
    displayOrder: 3,
    isActive: true,
    description: "European Space Agency"
  },
  {
    name: "ISRO",
    type: "Institutional Partner",
    logoUrl: "https://upload.wikimedia.org/wikipedia/commons/thumb/b/bd/Indian_Space_Research_Organisation_Logo.svg/320px-Indian_Space_Research_Organisation_Logo.svg.png",
    websiteUrl: "https://www.isro.gov.in",
    showOnHomepageMarquee: true,
    displayOrder: 4,
    isActive: true,
    description: "Indian Space Research Organisation"
  },
  {
    name: "Space Telescope Science Institute",
    type: "Institutional Partner",
    logoUrl: "https://upload.wikimedia.org/wikipedia/commons/thumb/5/5b/Space_Telescope_Science_Institute_logo.svg/320px-Space_Telescope_Science_Institute_logo.svg.png",
    websiteUrl: "https://www.stsci.edu",
    showOnHomepageMarquee: true,
    displayOrder: 5,
    isActive: true,
    description: "Operations center for Hubble and James Webb Space Telescopes"
  },
  {
    name: "Boeing",
    type: "Institutional Partner",
    logoUrl: "https://upload.wikimedia.org/wikipedia/commons/thumb/9/95/Boeing_logo.svg/320px-Boeing_logo.svg.png",
    websiteUrl: "https://www.boeing.com",
    showOnHomepageMarquee: true,
    displayOrder: 6,
    isActive: true,
    description: "Aerospace and defense corporation"
  },
  {
    name: "Maxar Technologies",
    type: "Institutional Partner",
    logoUrl: "https://upload.wikimedia.org/wikipedia/commons/thumb/a/a9/Maxar_Technologies_logo.svg/320px-Maxar_Technologies_logo.svg.png",
    websiteUrl: "https://www.maxar.com",
    showOnHomepageMarquee: true,
    displayOrder: 7,
    isActive: true,
    description: "Space technology and geospatial intelligence company"
  },
  {
    name: "Lockheed Martin",
    type: "Institutional Partner",
    logoUrl: "https://upload.wikimedia.org/wikipedia/commons/thumb/e/e6/Lockheed_Martin_2010_logo.svg/320px-Lockheed_Martin_2010_logo.svg.png",
    websiteUrl: "https://www.lockheedmartin.com",
    showOnHomepageMarquee: true,
    displayOrder: 8,
    isActive: true,
    description: "American aerospace, arms, defense, information security, and technology company"
  }
];

async function clearExistingOrganizations() {
  console.log('🧹 Clearing existing organizations...');
  const snapshot = await db.collection('organizations').get();
  const batch = db.batch();
  
  snapshot.forEach(doc => {
    batch.delete(doc.ref);
  });
  
  await batch.commit();
  console.log('✅ Cleared existing organizations');
}

async function addSampleOrganizations() {
  console.log('📝 Adding sample organizations...');
  
  for (const org of sampleOrganizations) {
    try {
      const docRef = await db.collection('organizations').add({
        ...org,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      });
      console.log(`✅ Added: ${org.name}`);
    } catch (error) {
      console.error(`❌ Failed to add ${org.name}:`, error);
    }
  }
}

async function main() {
  try {
    console.log('🚀 Starting sample organizations population...');
    
    await clearExistingOrganizations();
    await addSampleOrganizations();
    
    console.log('\n🎉 Population complete!');
    console.log('\n📊 Summary:');
    console.log(`- National Chapters: ${sampleOrganizations.filter(o => o.type === 'National Chapter').length}`);
    console.log(`- Institutional Partners: ${sampleOrganizations.filter(o => o.type === 'Institutional Partner').length}`);
    console.log(`- Total: ${sampleOrganizations.length} organizations`);
    
    console.log('\n🌐 The credibility marquee should now show on the homepage with these organizations!');
    console.log('🏠 Visit http://localhost:9004 to see the result');
    
  } catch (error) {
    console.error('❌ Error during population:', error);
    process.exit(1);
  }
}

// Run the script
main();