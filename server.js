// D:\Web Dev\Hack8\server.js
// --- Complete Code with Enhanced Logging ---

const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const admin = require('firebase-admin');
const cors = require('cors');

// --- Firebase Admin SDK Initialization ---
// Make sure this path points to your downloaded key file
const serviceAccount = require("./serviceAccountKey.json");

try {
    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
    });
    console.log("✅ Firebase Admin SDK Initialized Successfully.");
} catch (error) {
    console.error("\n🔴🔴🔴 Firebase Admin SDK Initialization Failed! 🔴🔴🔴");
    console.error("➡️ Ensure 'serviceAccountKey.json' is in the 'Hack8' directory.");
    console.error("➡️ Ensure the file content is the JSON downloaded from Firebase.");
    console.error("Error details:", error.message);
    process.exit(1); // Stop the server if it can't connect to Firebase
}

const db = admin.firestore(); // Get Firestore instance

// --- Express and Socket.IO Setup ---
const app = express();
// IMPORTANT: For production, change "*" to your actual frontend domain(s)
const allowedOrigins = "*"; // Allows connection from Live Server (e.g., http://127.0.0.1:5500) for development
app.use(cors({ origin: allowedOrigins }));

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: allowedOrigins,
    methods: ["GET", "POST"]
  }
});

const PORT = process.env.PORT || 3000; // Standard port for local dev

// --- Data Structures (In-Memory - Replace with Redis/DB for Production) ---
const connectedUsers = {}; // Maps userId (Firebase UID) -> socket.id
const activeChats = {};    // Maps roomName -> { clientUid, lawyerUid, ... }

// --- Socket.IO Middleware: Authenticate connections ---
io.use(async (socket, next) => {
    const token = socket.handshake.auth.token; // Get token sent by client
    if (!token) {
        console.warn(`🔌❌ Connection attempt without token rejected. Socket ID: ${socket.id}`);
        return next(new Error("Authentication error: No token provided"));
    }
    try {
        // Verify the token using Firebase Admin SDK
        const decodedToken = await admin.auth().verifyIdToken(token);
        const userId = decodedToken.uid;

        // Fetch user role and name from Firestore
        let userRole = 'unknown';
        let userData = {};
        const lawyerDoc = await db.collection('lawyers').doc(userId).get();
        if (lawyerDoc.exists) {
            userRole = 'lawyer';
            userData = lawyerDoc.data();
        } else {
            const clientDoc = await db.collection('client_users').doc(userId).get();
            if (clientDoc.exists) {
                userRole = 'client';
                userData = clientDoc.data();
            } else {
                 console.warn(`🤷‍♂️ User profile not found for UID: ${userId} in 'lawyers' or 'client_users'.`);
                 // Depending on requirements, you might reject here
                 // return next(new Error("Authentication error: User profile missing"));
            }
        }

        // Attach useful info to the socket object for easy access in event handlers
        socket.user = {
            uid: userId,
            email: decodedToken.email,
            role: userRole,
            name: userData.fullName || userData.displayName || userData.username || 'User',
        };

        console.log(`🔌✅ Socket Authenticated: User ${socket.user.uid} (${socket.user.name}, ${socket.user.role}), Socket ID ${socket.id}`);
        next(); // Authentication successful, allow connection

    } catch (error) {
        console.error(`🔌❌ Socket Authentication Failed:`, error.code, error.message);
        next(new Error(`Authentication error: ${error.code === 'auth/id-token-expired' ? 'Token expired' : 'Invalid token'}`));
    }
});

// --- Socket.IO Main Connection Logic ---
io.on('connection', (socket) => {
    if (!socket.user) { // Safety check after middleware
         console.error("Socket connected but user object is missing!");
         socket.disconnect(true);
         return;
    }
    const { uid: userId, name: userName, role: userRole } = socket.user;

    console.log(`👤 User Connected: ${userId} (${userName}, Role: ${userRole}) | Socket ID: ${socket.id}`);
    connectedUsers[userId] = socket.id; // Map Firebase UID to Socket ID
    console.log(`   ↳ Currently connected users: ${Object.keys(connectedUsers).length}`);

    // --- Event Handlers for this specific connection ---

    // 1. Client asks for lawyers matching their case info
    socket.on('request_lawyers', async (userData) => {
        // <<< START Enhanced Logging Block >>>
        console.log(`✅ RCV request_lawyers from ${socket.user.uid} (${socket.user.name}). Data:`, userData);

        if (socket.user.role !== 'client') {
            console.warn(`   ⚠️ Non-client user ${socket.user.uid} attempted request_lawyers.`);
            return;
        }
        // <<< END Enhanced Logging Block >>>

        try {
           let query = db.collection('lawyers').where('approved', '==', true);
           const requestedCaseType = userData.caseType;

           if (requestedCaseType && requestedCaseType !== 'Other') {
                console.log(`   🔎 Filtering by practice area: "${requestedCaseType}"`); // Log filter
                query = query.where('practiceAreas', 'array-contains', requestedCaseType);
           } else {
               console.log(`   🔎 No specific practice area filter applied.`); // Log if no filter
           }
           // Add more filters here if needed

           console.log(`   ⏳ Executing Firestore query...`); // Log before query
           const snapshot = await query.limit(5).get(); // Limit suggestions
           console.log(`   ✅ Firestore query completed. Found ${snapshot.size} documents.`); // Log result size

           const lawyers = [];
           if (!snapshot.empty) {
                snapshot.forEach(doc => {
                    const data = doc.data();
                    console.log(`      -> Found lawyer: ${doc.id}, Name: ${data.fullName || 'N/A'}, Areas: ${data.practiceAreas?.join(', ')}`); // Log each match
                    lawyers.push({
                        uid: doc.id,
                        name: data.fullName || data.displayName || 'Lawyer',
                        specialization: data.practiceAreas?.join(', ') || 'General Practice',
                        location: data.location || 'N/A',
                        rating: data.rating || 'N/A'
                    });
                });
           } else {
                console.log(`   🚫 No lawyers found matching criteria: caseType="${requestedCaseType}"`); // Specific log
           }

           console.log(`   📤 Emitting 'lawyer_suggestions' back to client ${socket.id} with ${lawyers.length} lawyers.`); // Log before emit
           socket.emit('lawyer_suggestions', lawyers);

        } catch (error) {
            console.error(`   ❌ Error during Firestore query or processing for ${socket.user.uid}:`, error); // Log the error
            socket.emit('lawyer_suggestions', []); // Send empty array on error
        }
    });

    // 2. Client selects a specific lawyer to chat with
    socket.on('select_lawyer', async (data) => {
        if (userRole !== 'client') return;
        const { lawyerUid, caseDetails } = data;
        if (!lawyerUid || !caseDetails) return console.warn("Invalid select_lawyer data");
        const clientUid = userId; const clientName = userName;
        console.log(` RCV select_lawyer: Client ${clientUid} chose Lawyer ${lawyerUid}`);
        const lawyerSocketId = connectedUsers[lawyerUid];
        const notificationId = `notif_${Date.now()}_${clientUid}`;
        const notificationData = {
            notificationId, clientUid, clientName,
            caseSummary: `Case: ${caseDetails?.caseType || 'N/A'}, Loc: ${caseDetails?.location || 'N/A'}`,
            fullCaseDetails: caseDetails, timestamp: Date.now(), status: 'pending'
        };
        const notifRef = db.collection('lawyers').doc(lawyerUid).collection('notifications').doc(notificationId);
        try {
            await notifRef.set(notificationData); console.log(`   ↳ Stored notification ${notificationId}`);
            if (lawyerSocketId) { io.to(lawyerSocketId).emit('new_notification', notificationData); console.log(`   ↳ Sent real-time notification to lawyer ${lawyerUid}`); }
            else { console.log(`   ↳ Lawyer ${lawyerUid} is offline.`); }
            socket.emit('awaiting_lawyer_response', { lawyerUid });
        } catch (err) { console.error("   ↳ Error storing/sending notification:", err); socket.emit('action_failed', { message: 'Failed to notify lawyer.' }); }
    });

    // 3. Lawyer accepts the chat request
    socket.on('accept_chat', async (data) => {
        if (userRole !== 'lawyer') return;
        const { clientUid, notificationId } = data;
        if (!clientUid || !notificationId) return console.warn("Invalid accept_chat data");
        const lawyerUid = userId; const lawyerName = userName; const lawyerSocketId = socket.id;
        console.log(` RCV accept_chat: Lawyer ${lawyerUid} accepting ${notificationId}`);
        const clientSocketId = connectedUsers[clientUid];
        const notifRef = db.collection('lawyers').doc(lawyerUid).collection('notifications').doc(notificationId);
        let clientNameFromNotif = 'Client';
        try {
            const notifDoc = await notifRef.get();
            if (!notifDoc.exists || notifDoc.data().status !== 'pending') throw new Error('Request invalid/handled.');
            clientNameFromNotif = notifDoc.data().clientName || 'Client';
            await notifRef.update({ status: 'accepted', acceptedAt: admin.firestore.FieldValue.serverTimestamp() }); console.log(`   ↳ Notification ${notificationId} accepted.`);
        } catch (err) { console.error("   ↳ Error accepting notification:", err); socket.emit('action_failed', { message: `Accept failed: ${err.message}` }); return; }
        if (!clientSocketId) { console.log(`   ↳ Client ${clientUid} offline.`); socket.emit('action_failed', { message: 'Client is offline.' }); return; }
        const roomName = `chat_${clientUid}_${lawyerUid}`;
        const clientSocket = io.sockets.sockets.get(clientSocketId);
        if (clientSocket) {
            clientSocket.join(roomName); socket.join(roomName);
            activeChats[roomName] = { clientUid, lawyerUid, clientSocketId, lawyerSocketId }; console.log(`   ↳ Room ${roomName} created. Active chats: ${Object.keys(activeChats).length}`);
            io.to(clientSocketId).emit('chat_accepted', { lawyerUid, lawyerName, roomName });
            socket.emit('start_chat', { clientUid, clientName: clientNameFromNotif, roomName, notificationId: notificationId }); // <<< Pass notificationId back
        } else { console.warn(`   ↳ Client socket object not found for ID ${clientSocketId}.`); socket.emit('action_failed', { message: 'Client connection error.' }); try { await notifRef.update({ status: 'pending' }); } catch (revertErr) {} }
    });

    // 4. Lawyer declines the chat request
    socket.on('decline_chat', async (data) => {
        if (userRole !== 'lawyer') return;
        const { clientUid, notificationId } = data;
        if (!clientUid || !notificationId) return console.warn("Invalid decline_chat data");
        const lawyerUid = userId; console.log(` RCV decline_chat: Lawyer ${lawyerUid} declining ${notificationId}`);
        try {
            const notifRef = db.collection('lawyers').doc(lawyerUid).collection('notifications').doc(notificationId);
            await notifRef.update({ status: 'declined', declinedAt: admin.firestore.FieldValue.serverTimestamp() }); console.log(`   ↳ Notification ${notificationId} marked declined.`);
        } catch (err) { console.error(`   ↳ Error declining notification:`, err); }
        const clientSocketId = connectedUsers[clientUid];
        if (clientSocketId) { io.to(clientSocketId).emit('chat_declined', { lawyerUid }); console.log(`   ↳ Notified client ${clientUid} of decline.`); }
    });

    // 5. User sends a message within a chat room
    socket.on('send_message', (data) => {
        const { roomName, text } = data;
        if (!roomName || !text || !socket.rooms.has(roomName)) { console.warn(`⚠️ Invalid 'send_message' from ${userId} (${userName}): Room missing or not joined.`); return; }
        const messageData = { senderUid: userId, senderName: userName, text: text.trim(), timestamp: Date.now() };
        console.log(` RCV message in ${roomName} from ${userName}: "${messageData.text.substring(0,30)}..."`);
        socket.to(roomName).emit('new_message', messageData);
        // TODO: Save message history to Firestore
    });

     // <<< ADDED: Handler for explicit room joining (e.g., on chat page refresh) >>>
     socket.on('join_room', (data) => {
        const { roomName } = data;
        if (!roomName) return console.warn(`⚠️ Invalid 'join_room' data from ${userId}.`);

        // Basic validation: should the user be allowed in this room?
        // Extract UIDs from roomName
        const uids = roomName.replace('chat_', '').split('_');
        if (uids.length !== 2 || !uids.includes(userId)) {
            console.warn(`🚨 User ${userId} attempted to join invalid/unauthorized room: ${roomName}`);
            // socket.emit('join_failed', { roomName, reason: 'Unauthorized' }); // Inform client
            return;
        }

        if (socket.rooms.has(roomName)) {
            console.log(`   User ${userId} already in room ${roomName}.`);
        } else {
            socket.join(roomName);
            console.log(`   ✅ User ${userId} explicitly joined room ${roomName}.`);
            // Update activeChats if necessary (e.g., update socket ID on reconnect)
            if (activeChats[roomName]) {
                 if (activeChats[roomName].clientUid === userId) activeChats[roomName].clientSocketId = socket.id;
                 if (activeChats[roomName].lawyerUid === userId) activeChats[roomName].lawyerSocketId = socket.id;
            }
        }
         // Optional: Send confirmation back to client
         // socket.emit('joined_room_ack', { roomName });
     });


    // --- Disconnect Handling ---
    socket.on('disconnect', (reason) => {
        console.log(`🔌 User Disconnected: ${userId} (${userName}). Reason: ${reason}. Socket ID: ${socket.id}`);
        if (connectedUsers[userId] === socket.id) { delete connectedUsers[userId]; }
        console.log(`   ↳ Currently connected users: ${Object.keys(connectedUsers).length}`);
        for (const roomName in activeChats) {
            const chat = activeChats[roomName]; let partnerUid = null;
            if (chat.clientUid === userId && chat.clientSocketId === socket.id) partnerUid = chat.lawyerUid;
            else if (chat.lawyerUid === userId && chat.lawyerSocketId === socket.id) partnerUid = chat.clientUid;
            if (partnerUid) {
                console.log(`   ↳ Notifying partner ${partnerUid} in room ${roomName}.`);
                const partnerSocketId = connectedUsers[partnerUid];
                if (partnerSocketId) io.to(partnerSocketId).emit('partner_disconnected', { roomName, disconnectedUser: userName });
                delete activeChats[roomName]; console.log(`   ↳ Active chats now: ${Object.keys(activeChats).length}`); break;
            }
        }
    });

    // --- Fetch Offline Notifications for Lawyer on Connect ---
    if (userRole === 'lawyer') {
        (async () => {
            try {
                console.log(`   ⏳ Fetching pending notifications for lawyer ${userId}...`); // <<< ADDED Log
                const snapshot = await db.collection('lawyers').doc(userId).collection('notifications')
                                  .where('status', '==', 'pending').orderBy('timestamp', 'desc').get();
                if (!snapshot.empty) {
                    snapshot.forEach(doc => {
                         console.log(`      -> Preparing stored notification: ${doc.id}`); // <<< ADDED Log
                         socket.emit('new_notification', doc.data());
                    });
                    console.log(`   ↳ Sent ${snapshot.size} stored notifications.`);
                } else {
                     console.log(`   ↳ No pending notifications found.`); // <<< ADDED Log
                }
            } catch (err) { console.error(`   ↳ Error fetching notifications:`, err); }
        })();
    }

}); // End io.on('connection')

// --- Basic HTTP Route (Health Check) ---
app.get('/', (req, res) => { res.send(`Legal Assist Chat Server OK: ${new Date().toLocaleTimeString()}`); });

// --- Start the Server ---
server.listen(PORT, () => {
    console.log(`\n🚀 Server listening on http://localhost:${PORT}`);
    console.log(`   Waiting for connections...`);
});