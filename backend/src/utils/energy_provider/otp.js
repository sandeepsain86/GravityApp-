const crypto = require('crypto');
/**
 * Generate a 6 digit OTP.
 */
const generateOtp = () => crypto.randomInt(100000, 1000000).toString();

module.exports = { generateOtp };

