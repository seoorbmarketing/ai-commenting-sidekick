module.exports = async (req, res) => {
  // Health check endpoint for monitoring
  res.status(200).json({ 
    status: 'ok',
    timestamp: new Date().toISOString(),
    service: 'AI Commenting Sidekick API',
    version: '1.0.0'
  });
};