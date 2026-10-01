const http = require('http');

console.log('🔍 Profile Page Permission Diagnostic Test');
console.log('==========================================');

// Test function to fetch profile page and look for errors
function testProfilePage() {
    const options = {
        hostname: 'localhost',
        port: 9004,
        path: '/profile/unified/test-user-id',
        method: 'GET'
    };

    console.log(`Testing: http://localhost:9004/profile/unified/test-user-id`);
    
    const req = http.request(options, (res) => {
        let data = '';
        
        res.on('data', (chunk) => {
            data += chunk;
        });
        
        res.on('end', () => {
            console.log(`Status Code: ${res.statusCode}`);
            
            // Look for error indicators in the response
            if (data.includes('FirebaseError') || data.includes('Missing or insufficient permissions')) {
                console.log('❌ PERMISSION ERROR DETECTED IN RESPONSE');
                
                // Extract error details
                const errorMatch = data.match(/FirebaseError[\s\S]*?\{[\s\S]*?\}/);
                if (errorMatch) {
                    console.log('Error Details:', errorMatch[0]);
                }
            } else {
                console.log('✅ No obvious permission errors in response');
            }
            
            // Check for our diagnostic error logs
            if (data.includes('*** FAILED TO FETCH')) {
                console.log('❌ DIAGNOSTIC ERROR LOGS FOUND:');
                const matches = data.match(/\*\*\* FAILED TO FETCH[^<]*/g);
                if (matches) {
                    matches.forEach(match => console.log(match.trim()));
                }
            } else {
                console.log('✅ No diagnostic error logs found');
            }
        });
    });

    req.on('error', (error) => {
        console.log('❌ Request failed:', error.message);
    });

    req.end();
}

// Test with different user IDs
testProfilePage();

// Also test the main profile route
setTimeout(() => {
    console.log('\nTesting main profile route...');
    const options2 = {
        hostname: 'localhost',
        port: 9004,
        path: '/profile',
        method: 'GET'
    };
    
    const req2 = http.request(options2, (res) => {
        console.log(`Profile route status: ${res.statusCode}`);
    });
    
    req2.on('error', (error) => {
        console.log('Profile route error:', error.message);
    });
    
    req2.end();
}, 2000);