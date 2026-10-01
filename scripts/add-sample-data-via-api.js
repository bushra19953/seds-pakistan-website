// Add sample organizations via the existing admin interface API
// This uses the same API structure as the app, avoiding Firebase config issues

const sampleOrganizations = [
  // National SEDS Chapters (Chapters)
  {
    id: "seds-usa",
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
    id: "ukseds", 
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
    id: "seds-india",
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
    id: "seds-germany",
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
    id: "seds-brazil",
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
    id: "seds-canada",
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
    id: "seds-japan", 
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
    id: "nasa",
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
    id: "spacex",
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
    id: "esa",
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
    id: "isro",
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
    id: "stsci",
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
    id: "boeing",
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
    id: "maxar",
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
    id: "lockheed",
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

console.log('🔧 Manual population instructions:');
console.log('\nTo add these organizations, you need to go to the admin interface:');
console.log('1. Visit: http://localhost:9004/admin/organizations');
console.log('2. Create each organization manually using the interface');
console.log('\nAlternatively, if you have Firebase Admin SDK access, you can run this with proper credentials.');

console.log('\n📊 Organizations to add:');
console.log('National Chapters:', sampleOrganizations.filter(o => o.type === 'National Chapter').length);
console.log('Institutional Partners:', sampleOrganizations.filter(o => o.type === 'Institutional Partner').length);
console.log('Total:', sampleOrganizations.length);

// Export for potential use
module.exports = { sampleOrganizations };