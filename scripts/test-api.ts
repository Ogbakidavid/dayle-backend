import 'dotenv/config';

async function test() {
  const API_URL = 'http://localhost:4000/api'; // Match .env + prefix
  
  try {
    console.log('Logging in...');
    const loginRes = await fetch(`${API_URL}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'admin@dayle.com',
        password: 'Password123!'
      })
    });
    
    if (!loginRes.ok) {
        const err = await loginRes.json();
        throw new Error(`Login failed: ${JSON.stringify(err)}`);
    }

    const loginData = await loginRes.json();
    const token = loginData.accessToken;
    console.log('Login successful. Token acquired.');

    console.log('Calling /admin/vaults...');
    const res = await fetch(`${API_URL}/admin/vaults`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    
    if (!res.ok) {
        const err = await res.json();
        console.error('API Error Response:', JSON.stringify(err, null, 2));
    } else {
        const data = await res.json();
        console.log('Success! Data count:', data.length);
    }
  } catch (error: any) {
    console.error('FAILED:');
    console.error(error.message);
  }
}

test();
