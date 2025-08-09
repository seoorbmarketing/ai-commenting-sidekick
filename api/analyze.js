const { supabaseAdmin } = require('../lib/supabase');
const { 
  rateLimit, 
  validateImageData, 
  sanitizeInput, 
  configureCORS, 
  logSecurityEvent,
  sanitizeError
} = require('../lib/security');
const OpenAI = require('openai');

// Initialize OpenAI with API key from environment
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// Verify OpenAI API key exists
if (!process.env.OPENAI_API_KEY) {
  console.error('[CRITICAL] OpenAI API key not configured');
  process.exit(1);
}

module.exports = async (req, res) => {
  const startTime = Date.now();
  console.log('[Analyze] Request received at:', new Date().toISOString());
  console.log('[Analyze] Request details:', {
    method: req.method,
    headers: {
      origin: req.headers.origin,
      authorization: req.headers.authorization ? 'Bearer...' : 'none'
    },
    bodyKeys: req.body ? Object.keys(req.body) : [],
    bodySize: JSON.stringify(req.body || {}).length
  });
  
  // Set a 8.5-second timeout for Vercel Hobby plan (10s limit minus buffer)
  const timeoutId = setTimeout(() => {
    console.error('[Analyze] Function timeout approaching - returning error');
    if (!res.headersSent) {
      res.status(504).json({ error: 'Request timeout - please try again with a smaller image' });
    }
  }, 8500);

  // Configure CORS
  if (!configureCORS(req, res)) {
    logSecurityEvent('CORS_BLOCKED', { 
      origin: req.headers.origin,
      ip: req.headers['x-forwarded-for'] || req.connection.remoteAddress 
    });
    return res.status(403).json({ error: 'Forbidden' });
  }

  if (req.method === 'OPTIONS') {
    console.log('[Analyze] OPTIONS request - returning 200');
    res.status(200).end();
    return;
  }

  if (req.method !== 'POST') {
    console.log('[Analyze] Invalid method:', req.method);
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const authHeader = req.headers.authorization;
  
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    console.log('[Analyze] No auth header or invalid format');
    return res.status(401).json({ error: 'Authentication required' });
  }

  const token = authHeader.replace('Bearer ', '');
  console.log('[Analyze] Token received:', token.substring(0, 20) + '...');
  let user;

  try {
    // Verify user authentication
    console.log('[Analyze] Verifying user authentication...');
    const { data: userData, error: authError } = await supabaseAdmin.auth.getUser(token);
    
    if (authError || !userData.user) {
      console.log('[Analyze] Auth failed:', authError?.message);
      logSecurityEvent('AUTH_FAILED', { token: token.substring(0, 10) + '...' });
      return res.status(401).json({ error: 'Authentication failed' });
    }
    
    user = userData.user;
    console.log('[Analyze] User authenticated:', user.id);
    
    // Rate limiting
    const rateLimitResult = await rateLimit(user.id, 'analyze');
    if (!rateLimitResult.allowed) {
      logSecurityEvent('RATE_LIMIT_EXCEEDED', { userId: user.id });
      return res.status(429).json({ 
        error: 'Too many requests, please try again later',
        retryAfter: rateLimitResult.retryAfter 
      });
    }

    // Validate request body
    const { imageDataUrl, context, systemPrompt, userApiKey } = req.body;

    // Validate image data
    const imageValidation = validateImageData(imageDataUrl);
    if (!imageValidation.valid) {
      logSecurityEvent('INVALID_IMAGE_DATA', { 
        userId: user.id, 
        error: imageValidation.error 
      });
      return res.status(400).json({ error: imageValidation.error });
    }

    // Sanitize text inputs
    const sanitizedContext = sanitizeInput(context);
    const sanitizedSystemPrompt = sanitizeInput(systemPrompt);

    // Check if user is using their own API key or credits
    const isUsingOwnApiKey = !!userApiKey;
    
    if (!isUsingOwnApiKey) {
      // Check available credits from credit_purchases table only
      const now = new Date().toISOString();
      const { data: activePurchases } = await supabaseAdmin
        .from('credit_purchases')
        .select('remaining_credits')
        .eq('user_id', user.id)
        .gt('expires_at', now)
        .gt('remaining_credits', 0);

      const availableCredits = activePurchases 
        ? activePurchases.reduce((sum, p) => sum + p.remaining_credits, 0)
        : 0;

      if (!availableCredits || availableCredits < 1) {
        return res.status(402).json({ 
          error: 'Insufficient credits', 
          available_credits: 0 
        });
      }
    }

    // Default system prompt with sanitization
    const DEFAULT_SYSTEM_PROMPT = `You are a helpful AI assistant that creates engaging social media comments and responses. 
Your responses should be:
- Friendly and conversational
- Relevant to the content shown
- Concise (1-3 sentences usually)
- Appropriate for the platform context
Never use quotation marks around your response.`;

    // Prepare OpenAI request
    const messages = [
      {
        role: 'system',
        content: sanitizedSystemPrompt || DEFAULT_SYSTEM_PROMPT
      },
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: sanitizedContext || 'Please analyze this image and provide an appropriate response.'
          },
          {
            type: 'image_url',
            image_url: {
              url: imageDataUrl,
              detail: 'low'  // Changed from 'high' to 'low' for faster processing
            }
          }
        ]
      }
    ];

    // Use user's API key if provided, otherwise use system key
    const openaiClient = isUsingOwnApiKey ? new OpenAI({ apiKey: userApiKey }) : openai;
    
    // Call OpenAI API with timeout
    console.log('[Analyze] About to call OpenAI API...');
    logSecurityEvent('OPENAI_REQUEST', { userId: user.id, usingOwnKey: isUsingOwnApiKey });
    
    // Create a timeout promise
    const openaiTimeout = new Promise((_, reject) => 
      setTimeout(() => reject(new Error('OpenAI API timeout')), 7000)
    );
    
    // Race between OpenAI call and timeout
    const completion = await Promise.race([
      openaiClient.chat.completions.create({
        model: 'gpt-4o-mini',  // Changed from gpt-4o to gpt-4o-mini for faster response
        messages: messages,
        max_tokens: 150,  // Reduced from 300 to 150 for faster generation
        temperature: 0.7,
        user: user.id // For OpenAI's abuse monitoring
      }),
      openaiTimeout
    ]);

    console.log('[Analyze] OpenAI API call completed');
    const aiResponse = completion.choices[0].message.content;
    const tokensUsed = completion.usage?.total_tokens || 0;
    console.log('[Analyze] Response length:', aiResponse.length, 'Tokens used:', tokensUsed);

    // Use credits (with transaction safety)
    let purchaseId = null;
    let subscriptionId = null;
    
    if (!isUsingOwnApiKey) {
      // First check if user has credits - query directly like credits.js does
      const now = new Date().toISOString();
      const { data: activePurchases, error: checkError } = await supabaseAdmin
        .from('credit_purchases')
        .select('remaining_credits, expires_at')
        .eq('user_id', user.id)
        .gt('remaining_credits', 0)
        .or(`expires_at.is.null,expires_at.gt.${now}`);
      
      console.log('[Analyze] Credit check:', {
        userId: user.id,
        purchases: activePurchases,
        error: checkError
      });
      
      const availableCredits = activePurchases?.reduce((sum, p) => sum + p.remaining_credits, 0) || 0;
      
      if (checkError || availableCredits < 1) {
        console.error('Insufficient credits:', {
          checkError,
          availableCredits,
          activePurchases,
          userId: user.id
        });
        return res.status(402).json({ 
          error: 'Insufficient credits. Please add more credits to continue.',
          available_credits: availableCredits,
          debug: { purchaseCount: activePurchases?.length || 0 }
        });
      }
      
      // Simple approach: Find and update in separate queries but with retry logic
      let retries = 3;
      let purchaseId = null;
      let subscriptionId = null;
      let creditDeducted = false;
      
      while (retries > 0 && !creditDeducted) {
        // Find the oldest credit purchase with remaining credits
        const { data: creditPurchase, error: findError } = await supabaseAdmin
          .from('credit_purchases')
          .select('id, remaining_credits, subscription_id')
          .eq('user_id', user.id)
          .gt('remaining_credits', 0)
          .or(`expires_at.is.null,expires_at.gt.${now}`)
          .order('created_at', { ascending: true })
          .limit(1)
          .single();
        
        if (findError || !creditPurchase) {
          console.error('No valid credit purchase found:', findError);
          return res.status(402).json({ 
            error: 'No valid credits found',
            details: findError?.message
          });
        }
        
        // Attempt to deduct 1 credit with optimistic locking
        const { data: creditResult, error: creditError } = await supabaseAdmin
          .from('credit_purchases')
          .update({ 
            remaining_credits: creditPurchase.remaining_credits - 1,
            updated_at: new Date().toISOString()
          })
          .eq('id', creditPurchase.id)
          .eq('remaining_credits', creditPurchase.remaining_credits)  // Optimistic lock
          .select()
          .single();
        
        if (creditResult) {
          creditDeducted = true;
          purchaseId = creditPurchase.id;
          subscriptionId = creditPurchase.subscription_id;
          console.log('[Analyze] Credit deducted successfully, remaining:', creditResult.remaining_credits);
        } else if (retries > 1) {
          // Retry if failed (likely due to concurrent update)
          console.log('[Analyze] Credit deduction failed, retrying...', retries - 1, 'attempts left');
          retries--;
          await new Promise(resolve => setTimeout(resolve, 100)); // Small delay before retry
        } else {
          console.error('Failed to deduct credit after retries:', creditError);
          return res.status(500).json({ 
            error: 'Failed to deduct credit - please try again',
            details: 'Concurrent request conflict'
          });
        }
      }
    }

    // Log usage (without storing sensitive data)
    const { error: logError } = await supabaseAdmin
      .from('api_usage')
      .insert([{
        user_id: user.id,
        purchase_id: purchaseId,
        subscription_id: subscriptionId,
        context: sanitizedContext ? sanitizedContext.substring(0, 100) : null, // Store only first 100 chars
        ai_response: aiResponse.substring(0, 200), // Store only first 200 chars
        credits_used: 1,
        api_key_used: isUsingOwnApiKey
      }]);

    if (logError) {
      console.error('Usage log error:', logError);
    }

    // Get updated credits from credit_purchases table only
    const now = new Date().toISOString();
    const { data: updatedPurchases } = await supabaseAdmin
      .from('credit_purchases')
      .select('remaining_credits')
      .eq('user_id', user.id)
      .gt('expires_at', now)
      .gt('remaining_credits', 0);

    const updatedCredits = updatedPurchases 
      ? updatedPurchases.reduce((sum, p) => sum + p.remaining_credits, 0)
      : 0;

    // Success response
    clearTimeout(timeoutId);
    const elapsed = Date.now() - startTime;
    console.log(`[Analyze] Success - completed in ${elapsed}ms`);
    
    return res.status(200).json({
      success: true,
      response: aiResponse,
      remaining_credits: updatedCredits || 0,
      tokens_used: tokensUsed
    });

  } catch (error) {
    clearTimeout(timeoutId);
    const elapsed = Date.now() - startTime;
    console.error(`[Analyze] Error after ${elapsed}ms:`, error.message);
    logSecurityEvent('API_ERROR', { 
      userId: user?.id,
      error: error.message,
      stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
    
    // Handle specific errors
    if (error.status === 429) {
      return res.status(429).json({ 
        error: 'OpenAI rate limit exceeded. Please try again later.' 
      });
    }
    
    if (error.status === 401) {
      // This should never happen if API key is correct
      console.error('[CRITICAL] OpenAI API authentication failed');
      return res.status(500).json({ 
        error: 'Service temporarily unavailable' 
      });
    }
    
    // Generic error response (don't leak details)
    return res.status(500).json({ 
      error: sanitizeError(error) 
    });
  }
};