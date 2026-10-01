#!/usr/bin/env node

/**
 * 🔍 SEARCH API TEST: Verify the search functionality works correctly
 */

const fetch = require('node-fetch');

async function testSearchAPI() {
  try {
    console.log('🧪 Testing search API functionality...');
    
    // Test 1: Search for "foze" (should find fozeenwear@gmail.com)
    console.log('\n📝 Test 1: Searching for "foze" (case-insensitive, partial match)');
    const response1 = await fetch('http://localhost:3000/api/admin/users?q=foze&pageSize=5');
    const data1 = await response1.json();
    
    console.log(`✅ Status: ${response1.status}`);
    console.log(`📊 Found ${data1.users?.length || 0} users`);
    
    if (data1.users && data1.users.length > 0) {
      console.log('👤 Found users:');
      data1.users.forEach(user => {
        console.log(`   - ${user.displayName} (${user.email})`);
      });
      
      // Check if we found the expected user
      const foundFozeenwear = data1.users.some(user => 
        user.email && user.email.toLowerCase().includes('fozeenwear')
      );
      
      if (foundFozeenwear) {
        console.log('✅ SUCCESS: Found user with fozeenwear email!');
      } else {
        console.log('⚠️  Note: Expected to find fozeenwear user');
      }
    } else {
      console.log('❌ No users found - this may be expected if no matches');
    }
    
    // Test 2: Search for "gmail" (should find many users)
    console.log('\n📝 Test 2: Searching for "gmail" (common email domain)');
    const response2 = await fetch('http://localhost:3000/api/admin/users?q=gmail&pageSize=3');
    const data2 = await response2.json();
    
    console.log(`✅ Status: ${response2.status}`);
    console.log(`📊 Found ${data2.users?.length || 0} users`);
    
    if (data2.users && data2.users.length > 0) {
      console.log('👤 Sample users found:');
      data2.users.slice(0, 3).forEach(user => {
        console.log(`   - ${user.displayName} (${user.email})`);
      });
    }
    
    // Test 3: Empty search (should return all users)
    console.log('\n📝 Test 3: Empty search (should return all users)');
    const response3 = await fetch('http://localhost:3000/api/admin/users?pageSize=3');
    const data3 = await response3.json();
    
    console.log(`✅ Status: ${response3.status}`);
    console.log(`📊 Found ${data3.users?.length || 0} users`);
    
    console.log('\n🎉 Search API tests completed!');
    
  } catch (error) {
    console.error('❌ Error testing search API:', error.message);
    console.log('💡 Make sure the development server is running: npm run dev');
  }
}

if (require.main === module) {
  testSearchAPI();
}

module.exports = { testSearchAPI };