const crypto = require('crypto');

// Rate limiting storage (in production, use Redis)
const rateLimitStore = new Map();

// Security configuration
const SECURITY_CONFIG = {
  MAX_REQUESTS_PER_MINUTE: 30, // Increased to allow parallel image analysis
  MAX_IMAGE_SIZE: 10 * 1024 * 1024, // 10MB
  ALLOWED_ORIGINS: process.env.ALLOWED_ORIGINS ? process.env.ALLOWED_ORIGINS.split(',') : [],
  REQUEST_SIGNATURE_SECRET: process.env.REQUEST_SIGNATURE_SECRET || process.env.JWT_SECRET
};

// Rate limiting middleware
async function rateLimit(userId, endpoint) {
  const key = `${userId}:${endpoint}`;
  const now = Date.now();
  const windowStart = now - 60000; // 1 minute window
  
  // Get user's request history
  const userRequests = rateLimitStore.get(key) || [];
  
  // Filter out old requests
  const recentRequests = userRequests.filter(timestamp => timestamp > windowStart);
  
  // Check if limit exceeded
  if (recentRequests.length >= SECURITY_CONFIG.MAX_REQUESTS_PER_MINUTE) {
    return {
      allowed: false,
      retryAfter: Math.ceil((recentRequests[0] + 60000 - now) / 1000)
    };
  }
  
  // Add current request
  recentRequests.push(now);
  rateLimitStore.set(key, recentRequests);
  
  // Clean up old entries periodically
  if (Math.random() < 0.1) {
    for (const [k, v] of rateLimitStore.entries()) {
      const filtered = v.filter(t => t > windowStart);
      if (filtered.length === 0) {
        rateLimitStore.delete(k);
      } else {
        rateLimitStore.set(k, filtered);
      }
    }
  }
  
  return { allowed: true };
}

// Validate and sanitize image data
function validateImageData(imageDataUrl) {
  if (!imageDataUrl || typeof imageDataUrl !== 'string') {
    return { valid: false, error: 'Invalid image data' };
  }
  
  // Check if it's a valid data URL
  const dataUrlRegex = /^data:image\/(jpeg|jpg|png|webp);base64,/;
  if (!dataUrlRegex.test(imageDataUrl)) {
    return { valid: false, error: 'Invalid image format' };
  }
  
  // Extract base64 data
  const base64Data = imageDataUrl.split(',')[1];
  if (!base64Data) {
    return { valid: false, error: 'Invalid image data' };
  }
  
  // Check size (approximate)
  const sizeInBytes = (base64Data.length * 3) / 4;
  if (sizeInBytes > SECURITY_CONFIG.MAX_IMAGE_SIZE) {
    return { valid: false, error: 'Image too large (max 10MB)' };
  }
  
  // Validate base64
  try {
    Buffer.from(base64Data, 'base64');
  } catch (error) {
    return { valid: false, error: 'Invalid base64 data' };
  }
  
  return { valid: true };
}

// Sanitize user input
function sanitizeInput(input) {
  if (!input) return '';
  
  // Remove any potential XSS attempts
  return String(input)
    .replace(/[<>]/g, '') // Remove angle brackets
    .trim()
    .slice(0, 1000); // Limit length
}

// Verify request signature (optional enhanced security)
function generateRequestSignature(data, timestamp) {
  const payload = `${timestamp}:${JSON.stringify(data)}`;
  return crypto
    .createHmac('sha256', SECURITY_CONFIG.REQUEST_SIGNATURE_SECRET)
    .update(payload)
    .digest('hex');
}

function verifyRequestSignature(data, timestamp, signature) {
  // Check timestamp is within 5 minutes
  const now = Date.now();
  const requestTime = parseInt(timestamp);
  if (isNaN(requestTime) || Math.abs(now - requestTime) > 300000) {
    return false;
  }
  
  const expectedSignature = generateRequestSignature(data, timestamp);
  return crypto.timingSafeEqual(
    Buffer.from(signature),
    Buffer.from(expectedSignature)
  );
}

// CORS configuration
function configureCORS(req, res) {
  const origin = req.headers.origin;
  
  // In production, validate against allowed origins
  if (process.env.NODE_ENV === 'production') {
    if (origin && SECURITY_CONFIG.ALLOWED_ORIGINS.includes(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
    } else if (origin && origin.startsWith('chrome-extension://')) {
      // Allow Chrome extensions
      res.setHeader('Access-Control-Allow-Origin', origin);
    } else {
      // No CORS headers = request blocked
      return false;
    }
  } else {
    // Development mode
    res.setHeader('Access-Control-Allow-Origin', '*');
  }
  
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,POST');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-Request-Timestamp, X-Request-Signature');
  
  return true;
}

// Log security events
function logSecurityEvent(event, details) {
  console.log(`[SECURITY] ${event}:`, {
    timestamp: new Date().toISOString(),
    ...details
  });
}

// Sanitize error messages (don't leak internal details)
function sanitizeError(error) {
  const knownErrors = {
    'Invalid API key': 'Authentication failed',
    'No authorization header': 'Authentication required',
    'Insufficient credits': 'Insufficient credits',
    'Invalid image data': 'Invalid image data',
    'Image too large': 'Image too large (max 10MB)',
    'Rate limit exceeded': 'Too many requests, please try again later'
  };
  
  // Check if it's a known error
  for (const [key, value] of Object.entries(knownErrors)) {
    if (error.message && error.message.includes(key)) {
      return value;
    }
  }
  
  // Generic error for unknown issues
  return 'An error occurred processing your request';
}

module.exports = {
  rateLimit,
  validateImageData,
  sanitizeInput,
  generateRequestSignature,
  verifyRequestSignature,
  configureCORS,
  logSecurityEvent,
  sanitizeError,
  SECURITY_CONFIG
};