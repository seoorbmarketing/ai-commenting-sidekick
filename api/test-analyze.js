const { supabaseAdmin } = require('../lib/supabase');
const { configureCORS, logSecurityEvent } = require('../lib/security');

module.exports = async (req, res) => {
  console.log('[Test-Analyze] Endpoint called at', new Date().toISOString());
  
  // Configure CORS
  if (!configureCORS(req, res)) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const authHeader = req.headers.authorization;
  
  try {
    console.log('[Test-Analyze] Step 1: Checking auth header...');
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ 
        error: 'Authentication required',
        debug: 'No bearer token found'
      });
    }

    const token = authHeader.replace('Bearer ', '');
    
    console.log('[Test-Analyze] Step 2: Verifying user with Supabase...');
    const startSupabase = Date.now();
    const { data: userData, error: authError } = await supabaseAdmin.auth.getUser(token);
    const supabaseTime = Date.now() - startSupabase;
    console.log('[Test-Analyze] Supabase auth took', supabaseTime, 'ms');
    
    if (authError || !userData.user) {
      return res.status(401).json({ 
        error: 'Authentication failed',
        debug: authError?.message || 'Invalid token'
      });
    }
    
    const user = userData.user;
    console.log('[Test-Analyze] User authenticated:', user.id);
    
    // Check body parsing
    console.log('[Test-Analyze] Step 3: Checking request body...');
    const { imageDataUrl, context } = req.body;
    
    if (!imageDataUrl) {
      return res.status(400).json({ 
        error: 'Image data required',
        debug: 'No imageDataUrl in body'
      });
    }
    
    const imageSize = imageDataUrl ? imageDataUrl.length : 0;
    console.log('[Test-Analyze] Image size:', imageSize, 'characters');
    
    // Check credits
    console.log('[Test-Analyze] Step 4: Checking credits...');
    const startCredits = Date.now();
    const now = new Date().toISOString();
    const { data: activePurchases, error: creditsError } = await supabaseAdmin
      .from('credit_purchases')
      .select('remaining_credits')
      .eq('user_id', user.id)
      .gt('remaining_credits', 0)
      .or(`expires_at.is.null,expires_at.gt.${now}`);
    
    const creditsTime = Date.now() - startCredits;
    console.log('[Test-Analyze] Credits check took', creditsTime, 'ms');
    
    const availableCredits = activePurchases 
      ? activePurchases.reduce((sum, p) => sum + p.remaining_credits, 0)
      : 0;
    
    console.log('[Test-Analyze] Available credits:', availableCredits);
    
    if (availableCredits < 1) {
      return res.status(402).json({ 
        error: 'Insufficient credits',
        available_credits: availableCredits
      });
    }
    
    // Don't actually call OpenAI, just return a test response
    console.log('[Test-Analyze] Step 5: Would call OpenAI here...');
    console.log('[Test-Analyze] Skipping OpenAI call for test');
    
    return res.status(200).json({
      success: true,
      response: 'This is a test response. The analyze endpoint is working up to the OpenAI call.',
      remaining_credits: availableCredits,
      debug: {
        supabaseAuthTime: supabaseTime,
        creditsCheckTime: creditsTime,
        imageSize: imageSize,
        userId: user.id
      }
    });
    
  } catch (error) {
    console.error('[Test-Analyze] Error:', error);
    return res.status(500).json({ 
      error: error.message,
      stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  }
};