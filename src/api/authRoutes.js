'use strict';

// Import dependencies
const Salsa20 = require('js-salsa20')
const {TextEncoder, TextDecoder} = require('util');
const jwt = require('jsonwebtoken');
const {RateLimiterCluster, RateLimiterMemory} = require('rate-limiter-flexible');

// Define constants
const authDelay = 10;

// Declare new router and start defining routes:
const authRoutes = require('express').Router();

// Rate limit 3 requests per hour
const rateLimiter = process.env.NODE_ENV === 'production' ?
    new RateLimiterCluster({
        keyPrefix: 'pm2clusterlimiter', // name the limiter something unique
        points: 3, // 3 requests
        duration: 3600, // per hour
        timeoutMs: 3000 // Promise is rejected, if master doesn't answer for 3 secs (cluster option)
    }) :
    new RateLimiterMemory({
        keyPrefix: 'memorylimiter', // name the limiter something unique
        points: 3, // 3 requests
        duration: 3600, // per hour
        timeoutMs: 3000 // Promise is rejected, if master doesn't answer for 3 secs (cluster option)
    })

async function rateLimit(req, res, next) {
    try {
        await rateLimiter.consume(process.env.NODE_ENV === 'production' ? req.headers['x-real-ip'] : req.client.remoteAddress);
        next();
    } catch (RateLimiterRes) {
        res.status(429).json({auth: false, message: 'Too Many Requests'});
    }
}

/**
 * /api/v1/login
 * ------
 * Handle API login requests.
 * ------
 * This will hash a token that should be identical to the one generated by the client.
 * (It will check up to five seconds back )
 * If validated, it will generate a token that can be used by the client for one hour.
 */
authRoutes.post('/login', rateLimit, async (req, res) => {
    try {
        const [ivString, encryptedString] = req.body.clientID.split('|');

        const hexToBytes = hex => new Uint8Array(hex.match(/.{1,2}/g).map(byte => parseInt(byte, 16)));

        const encoder = new TextEncoder();
        const decoder = new TextDecoder();

        const key = encoder.encode(process.env.SECRET_CLIENT_ID.substring(0, 32));
        const iv = hexToBytes(ivString);
        const encrypted = hexToBytes(encryptedString);

        const encrypter = new Salsa20(key, iv);
        const messageBytes = encrypter.decrypt(encrypted);
        const message = decoder.decode(messageBytes);

        let clientIsValid = false;
        const now = Math.floor((new Date()).valueOf() / 1000);

        for (let time = now; time >= now - authDelay && !clientIsValid; time--) {
            clientIsValid = message === `${time}|${process.env.SECRET_CLIENT_ID}`
        }

        if (!clientIsValid) {
            return res.status(401).json({auth: false, token: null});
        }

        // create a token
        const token = jwt.sign({id: 'ApolloTV Official App', message: 'This better be from our app...', ip: req.client.remoteAddress}, process.env.SECRET_SERVER_ID, {
            expiresIn: 3600 // expires in 1 hour
        });

        // return the information including token as JSON
        res.json({auth: true, token});
    } catch (err) {
        return res.status(401).json({auth: false, token: null});
    }
});

module.exports = authRoutes;