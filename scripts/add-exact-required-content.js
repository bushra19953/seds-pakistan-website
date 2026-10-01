// Exact Content List as Required
// This script contains the precise organizations that must be added

const nationalChapterFlags = [
  { id: "seds-usa", name: "SEDS USA", type: "National Chapter", logoUrl: "https://flagcdn.com/w320/us.png", websiteUrl: "https://sedsusa.org", description: "Students for the Exploration and Development of Space - USA" },
  { id: "ukseds", name: "UKSEDS", type: "National Chapter", logoUrl: "https://flagcdn.com/w320/gb.png", websiteUrl: "https://ukseds.org", description: "UK Students for the Exploration and Development of Space" },
  { id: "seds-canada", name: "SEDS Canada", type: "National Chapter", logoUrl: "https://flagcdn.com/w320/ca.png", websiteUrl: "https://seds.ca", description: "Students for the Exploration and Development of Space - Canada" },
  { id: "seds-india", name: "SEDS India", type: "National Chapter", logoUrl: "https://flagcdn.com/w320/in.png", websiteUrl: "https://sedsindia.org", description: "Students for the Exploration and Development of Space - India" },
  { id: "seds-brazil", name: "SEDS Brazil", type: "National Chapter", logoUrl: "https://flagcdn.com/w320/br.png", websiteUrl: "https://sedsbrasil.org", description: "Students for the Exploration and Development of Space - Brazil" },
  { id: "seds-nepal", name: "SEDS Nepal", type: "National Chapter", logoUrl: "https://flagcdn.com/w320/np.png", websiteUrl: "https://sedsnepal.org", description: "Students for the Exploration and Development of Space - Nepal" },
  { id: "seds-japan", name: "SEDS Japan", type: "National Chapter", logoUrl: "https://flagcdn.com/w320/jp.png", websiteUrl: "https://seds-japan.org", description: "Students for the Exploration and Development of Space - Japan" },
  { id: "seds-uae", name: "SEDS UAE", type: "National Chapter", logoUrl: "https://flagcdn.com/w320/ae.png", websiteUrl: "https://sedsuae.org", description: "Students for the Exploration and Development of Space - UAE" },
  { id: "seds-australia", name: "SEDS Australia", type: "National Chapter", logoUrl: "https://flagcdn.com/w320/au.png", websiteUrl: "https://seds.edu.au", description: "Students for the Exploration and Development of Space - Australia" },
  { id: "seds-philippines", name: "SEDS Philippines", type: "National Chapter", logoUrl: "https://flagcdn.com/w320/ph.png", websiteUrl: "https://sedsph.org", description: "Students for the Exploration and Development of Space - Philippines" },
  { id: "seds-nigeria", name: "SEDS Nigeria", type: "National Chapter", logoUrl: "https://flagcdn.com/w320/ng.png", websiteUrl: "https://sedsnigeria.org", description: "Students for the Exploration and Development of Space - Nigeria" },
  { id: "seds-sri-lanka", name: "SEDS Sri Lanka", type: "National Chapter", logoUrl: "https://flagcdn.com/w320/lk.png", websiteUrl: "https://sedssl.org", description: "Students for the Exploration and Development of Space - Sri Lanka" },
  { id: "seds-south-africa", name: "SEDS South Africa", type: "National Chapter", logoUrl: "https://flagcdn.com/w320/za.png", websiteUrl: "https://seds.org.za", description: "Students for the Exploration and Development of Space - South Africa" },
  { id: "seds-puerto-rico", name: "SEDS Puerto Rico", type: "National Chapter", logoUrl: "https://flagcdn.com/w320/pr.png", websiteUrl: "https://sedspr.org", description: "Students for the Exploration and Development of Space - Puerto Rico" },
  { id: "seds-angola", name: "SEDS Angola", type: "National Chapter", logoUrl: "https://flagcdn.com/w320/ao.png", websiteUrl: "https://seds.ao", description: "Students for the Exploration and Development of Space - Angola" },
  { id: "seds-singapore", name: "SEDS Singapore", type: "National Chapter", logoUrl: "https://flagcdn.com/w320/sg.png", websiteUrl: "https://seds.sg", description: "Students for the Exploration and Development of Space - Singapore" },
  { id: "seds-argentina", name: "SEDS Argentina", type: "National Chapter", logoUrl: "https://flagcdn.com/w320/ar.png", websiteUrl: "https://seds.org.ar", description: "Students for the Exploration and Development of Space - Argentina" },
  { id: "seds-spain", name: "SEDS Spain", type: "National Chapter", logoUrl: "https://flagcdn.com/w320/es.png", websiteUrl: "https://seds.es", description: "Students for the Exploration and Development of Space - Spain" },
  { id: "seds-turkey", name: "SEDS Turkey", type: "National Chapter", logoUrl: "https://flagcdn.com/w320/tr.png", websiteUrl: "https://seds.org.tr", description: "Students for the Exploration and Development of Space - Turkey" },
  { id: "seds-tunisia", name: "SEDS Tunisia", type: "National Chapter", logoUrl: "https://flagcdn.com/w320/tn.png", websiteUrl: "https://seds.tn", description: "Students for the Exploration and Development of Space - Tunisia" },
  { id: "seds-new-zealand", name: "SEDS New Zealand", type: "National Chapter", logoUrl: "https://flagcdn.com/w320/nz.png", websiteUrl: "https://seds.org.nz", description: "Students for the Exploration and Development of Space - New Zealand" },
  { id: "seds-zimbabwe", name: "SEDS Zimbabwe", type: "National Chapter", logoUrl: "https://flagcdn.com/w320/zw.png", websiteUrl: "https://seds.zw", description: "Students for the Exploration and Development of Space - Zimbabwe" },
  { id: "seds-france", name: "SEDS France", type: "National Chapter", logoUrl: "https://flagcdn.com/w320/fr.png", websiteUrl: "https://seds.fr", description: "Students for the Exploration and Development of Space - France" },
  { id: "seds-ireland", name: "SEDS Ireland", type: "National Chapter", logoUrl: "https://flagcdn.com/w320/ie.png", websiteUrl: "https://seds.ie", description: "Students for the Exploration and Development of Space - Ireland" },
  { id: "seds-italy", name: "SEDS Italy", type: "National Chapter", logoUrl: "https://flagcdn.com/w320/it.png", websiteUrl: "https://seds.it", description: "Students for the Exploration and Development of Space - Italy" },
  { id: "seds-chile", name: "SEDS Chile", type: "National Chapter", logoUrl: "https://flagcdn.com/w320/cl.png", websiteUrl: "https://seds.cl", description: "Students for the Exploration and Development of Space - Chile" },
  { id: "seds-pakistan", name: "SEDS Pakistan", type: "National Chapter", logoUrl: "https://flagcdn.com/w320/pk.png", websiteUrl: "https://seds.org.pk", description: "Students for the Exploration and Development of Space - Pakistan" }
];

const institutionalPartners = [
  { id: "via-satellite", name: "Via Satellite", type: "Institutional Partner", logoUrl: "https://via.placeholder.com/320x120/1e3a8a/ffffff?text=Via+Satellite", websiteUrl: "https://www.viasatellite.com", description: "Leading publication for satellite industry news and analysis" },
  { id: "space-for-humanity", name: "Space For Humanity", type: "Institutional Partner", logoUrl: "https://via.placeholder.com/320x120/8b5cf6/ffffff?text=Space+For+Humanity", websiteUrl: "https://spaceforhumanity.org", description: "Non-profit democratizing access to space" },
  { id: "space-station-explorers", name: "Space Station Explorers", type: "Institutional Partner", logoUrl: "https://via.placeholder.com/320x120/0ea5e9/ffffff?text=Space+Station+Explorers", websiteUrl: "https://spacestationexplorers.org", description: "Educational programs about International Space Station" },
  { id: "future-space-leaders", name: "Future Space Leaders Foundation", type: "Institutional Partner", logoUrl: "https://via.placeholder.com/320x120/f59e0b/ffffff?text=Future+Space+Leaders", websiteUrl: "https://futurespaceleaders.org", description: "Supporting the next generation of space professionals" },
  { id: "sspi", name: "Space & Satellite Professionals International", type: "Institutional Partner", logoUrl: "https://via.placeholder.com/320x120/059669/ffffff?text=SSPI", websiteUrl: "https://sspi.org", description: "Professional association for space and satellite industry" },
  { id: "sgac", name: "Space Generation Advisory Council", type: "Institutional Partner", logoUrl: "https://via.placeholder.com/320x120/dc2626/ffffff?text=SGAC", websiteUrl: "https://spacegeneration.org", description: "The voice of students and young space professionals" },
  { id: "alliance-space-development", name: "Alliance for Space Development", type: "Institutional Partner", logoUrl: "https://via.placeholder.com/320x120/7c3aed/ffffff?text=ASD", websiteUrl: "https://allianceforspacedevelopment.org", description: "Coalition promoting space development advocacy" },
  { id: "international-space-university", name: "International Space University", type: "Institutional Partner", logoUrl: "https://via.placeholder.com/320x120/2563eb/ffffff?text=ISU", websiteUrl: "https://isunet.edu", description: "Graduate level education in all space disciplines" },
  { id: "nasa-stem", name: "NASA STEM Engagement", type: "Institutional Partner", logoUrl: "https://upload.wikimedia.org/wikipedia/commons/thumb/e/e5/NASA_logo.svg/320px-NASA_logo.svg.png", websiteUrl: "https://www.nasa.gov/stem", description: "NASA's Science, Technology, Engineering and Mathematics engagement" },
  { id: "iss-national-lab", name: "ISS National Lab", type: "Institutional Partner", logoUrl: "https://via.placeholder.com/320x120/0369a1/ffffff?text=ISS+National+Lab", websiteUrl: "https://www.issnationallab.org", description: "International Space Station National Laboratory" },
  { id: "ncgsa", name: "NCGSA", type: "Institutional Partner", logoUrl: "https://via.placeholder.com/320x120/7c2d12/ffffff?text=NCGSA", websiteUrl: "https://ncgsa.org", description: "National Council on Geographic Education and Space Applications" }
];

console.log('📋 EXACT REQUIRED CONTENT FOR CREDIBILITY MARQUEE');
console.log('\n🏴 National Chapter Flags:', nationalChapterFlags.length);
nationalChapterFlags.forEach((org, index) => {
  console.log(`${index + 1}. ${org.name} (${org.id})`);
});

console.log('\n🏢 Institutional Partners:', institutionalPartners.length);
institutionalPartners.forEach((org, index) => {
  console.log(`${index + 1}. ${org.name} (${org.id})`);
});

console.log('\n✅ Total Organizations:', nationalChapterFlags.length + institutionalPartners.length);

module.exports = { nationalChapterFlags, institutionalPartners };