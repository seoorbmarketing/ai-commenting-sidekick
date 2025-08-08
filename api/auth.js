const { supabaseClient } = require('../lib/supabase');

module.exports = async (req, res) => {
  // Check if Supabase is configured
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_ANON_KEY) {
    console.error('[Auth] Supabase not configured');
    return res.status(500).json({ error: 'Service configuration error' });
  }
  // Enable CORS
  res.setHeader('Access-Control-Allow-Credentials', true);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT');
  res.setHeader('Access-Control-Allow-Headers', 'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version, Authorization');

  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  const { action } = req.query;

  try {
    switch (action) {
      case 'signup':
        return await handleSignup(req, res);
      case 'login':
        return await handleLogin(req, res);
      case 'logout':
        return await handleLogout(req, res);
      case 'refresh':
        return await handleRefresh(req, res);
      case 'user':
        return await handleGetUser(req, res);
      default:
        return res.status(400).json({ error: 'Invalid action' });
    }
  } catch (error) {
    console.error('Auth error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
};

async function handleSignup(req, res) {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password required' });
  }

  const { data, error } = await supabaseClient.auth.signUp({
    email,
    password,
  });

  if (error) {
    // Handle rate limit errors more gracefully
    if (error.message && error.message.includes('after') && error.message.includes('seconds')) {
      console.log('[Auth] Rate limit hit:', error.message);
      // Extract wait time if possible
      const match = error.message.match(/after (\d+) seconds/);
      const waitTime = match ? match[1] : '60';
      return res.status(429).json({ 
        error: `Too many signup attempts. Please wait ${waitTime} seconds and try again.`,
        retryAfter: parseInt(waitTime)
      });
    }
    return res.status(400).json({ error: error.message });
  }

  // Create user profile
  if (data.user) {
    try {
      const { error: profileError } = await supabaseClient
        .from('users')
        .insert([{ 
          id: data.user.id, 
          email: data.user.email,
          user_type: 'free'
        }]);

      if (profileError) {
        console.error('Profile creation error:', profileError);
        // Don't fail the signup if profile creation fails
        // User can still verify email and profile can be created later
      }
    } catch (err) {
      console.error('Profile creation exception:', err);
    }
  }

  // Don't return session if email needs confirmation
  const responseData = {
    user: data.user,
    message: 'Please check your email to verify your account'
  };
  
  // Only include session if email is already confirmed (shouldn't happen with confirm email enabled)
  if (data.user?.confirmed_at) {
    responseData.session = data.session;
  }
  
  return res.status(200).json(responseData);
}

async function handleLogin(req, res) {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password required' });
  }

  const { data, error } = await supabaseClient.auth.signInWithPassword({
    email,
    password,
  });

  if (error) {
    return res.status(401).json({ error: error.message });
  }

  // Check if email is confirmed
  if (data.user && !data.user.confirmed_at) {
    return res.status(403).json({ 
      error: 'Please verify your email before logging in. Check your inbox for the verification link.' 
    });
  }

  // Ensure user profile exists (in case it failed during signup)
  if (data.user) {
    const { data: existingUser } = await supabaseClient
      .from('users')
      .select('id')
      .eq('id', data.user.id)
      .single();

    if (!existingUser) {
      console.log('[Auth] Creating missing user profile on login');
      await supabaseClient
        .from('users')
        .insert([{
          id: data.user.id,
          email: data.user.email,
          user_type: 'free'
        }]);
    }
  }

  return res.status(200).json({ 
    user: data.user,
    session: data.session 
  });
}

async function handleLogout(req, res) {
  const authHeader = req.headers.authorization;
  
  if (!authHeader) {
    return res.status(401).json({ error: 'No authorization header' });
  }

  const token = authHeader.replace('Bearer ', '');
  
  const { error } = await supabaseClient.auth.signOut();

  if (error) {
    return res.status(400).json({ error: error.message });
  }

  return res.status(200).json({ message: 'Logged out successfully' });
}

async function handleRefresh(req, res) {
  const { refresh_token } = req.body;

  if (!refresh_token) {
    return res.status(400).json({ error: 'Refresh token required' });
  }

  const { data, error } = await supabaseClient.auth.refreshSession({ 
    refresh_token 
  });

  if (error) {
    return res.status(401).json({ error: error.message });
  }

  return res.status(200).json({ 
    user: data.user,
    session: data.session 
  });
}

async function handleGetUser(req, res) {
  const authHeader = req.headers.authorization;
  
  if (!authHeader) {
    return res.status(401).json({ error: 'No authorization header' });
  }

  const token = authHeader.replace('Bearer ', '');

  const { data: { user }, error } = await supabaseClient.auth.getUser(token);

  if (error) {
    return res.status(401).json({ error: error.message });
  }

  // Get user's available credits from credit_purchases only
  const now = new Date().toISOString();
  const { data: activePurchases } = await supabaseClient
    .from('credit_purchases')
    .select('expires_at, remaining_credits')
    .eq('user_id', user.id)
    .gt('expires_at', now)
    .gt('remaining_credits', 0)
    .order('expires_at', { ascending: true });

  const credits = activePurchases 
    ? activePurchases.reduce((sum, p) => sum + p.remaining_credits, 0)
    : 0;

  // Get user profile with type
  const { data: profile } = await supabaseClient
    .from('users')
    .select('user_type')
    .eq('id', user.id)
    .single();

  let daysUntilExpiry = null;
  if (activePurchases && activePurchases.length > 0) {
    const expiryDate = new Date(activePurchases[0].expires_at);
    const today = new Date();
    const diffTime = expiryDate - today;
    daysUntilExpiry = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
  }

  return res.status(200).json({ 
    user: {
      ...user,
      user_type: profile?.user_type || 'free'
    },
    available_credits: credits || 0,
    days_until_expiry: daysUntilExpiry
  });
}