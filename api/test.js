// Simple test endpoint to verify backend is working
module.exports = async (req, res) => {
  console.log('[Test] Endpoint called at', new Date().toISOString());
  console.log('[Test] Method:', req.method);
  console.log('[Test] Headers:', req.headers);
  
  // Enable CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }
  
  // Return basic info
  return res.status(200).json({
    success: true,
    message: 'Backend is working',
    timestamp: new Date().toISOString(),
    method: req.method,
    env: {
      hasOpenAI: !!process.env.OPENAI_API_KEY,
      hasSupabase: !!process.env.SUPABASE_URL,
      hasStripe: !!process.env.STRIPE_SECRET_KEY
    }
  });
};