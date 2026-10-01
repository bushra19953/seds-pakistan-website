async function verify(token) {
  console.log('--- VERIFYING API ACCESS ---');
  
  // 1. Test POST /api/blogs (Authorized for blog_only_editor)
  console.log('\n[1] Testing POST /api/blogs (Should be 200/201)...');
  const postRes = await fetch('http://localhost:3000/api/blogs', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      title: 'RBAC Test Post',
      content: 'This is a test post to verify dynamic RBAC.',
      authorId: 'gO4vHAoVuoTrNbXMTqPt0w35kpq1',
      authorName: 'Test Manager'
    })
  });
  console.log('Status:', postRes.status);
  if (postRes.ok) {
    const data = await postRes.json();
    console.log('✅ Success: Post created with ID:', data.id);
  } else {
    const text = await postRes.text();
    console.log('❌ Failed:', text);
  }

  // 2. Test GET /api/admin/users (Unauthorized for blog_only_editor)
  console.log('\n[2] Testing GET /api/admin/users (Should be 403)...');
  const getUsersRes = await fetch('http://localhost:3000/api/admin/users', {
    headers: {
      'Authorization': `Bearer ${token}`
    }
  });
  console.log('Status:', getUsersRes.status);
  if (getUsersRes.status === 403) {
    console.log('✅ Success: Correctly denied access with 403.');
  } else if (getUsersRes.ok) {
    console.log('❌ Failed: Access should have been denied but was granted.');
  } else {
    const text = await getUsersRes.text();
    console.log('ℹ️ Other status:', text);
  }
}

const token = process.argv[2];
if (!token) {
  console.error('Token required');
  process.exit(1);
}

verify(token);
