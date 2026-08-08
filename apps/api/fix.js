const fs = require('fs');
const path = require('path');

(async () => {
  const dir = path.join(__dirname, 'test');
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.e2e-spec.ts'));

  const comprehensiveCleanup =     await prisma.chatHandoff.deleteMany({});
      await prisma.chatSession.deleteMany({});
      await prisma.paymentEvent.deleteMany({});
      await prisma.ledgerEntry.deleteMany({});
      await prisma.refund.deleteMany({});
      await prisma.payment.deleteMany({});
      await prisma.idempotencyKey.deleteMany({});
      await prisma.paymentMethod.deleteMany({});
      await prisma.bookingIntentPassenger.deleteMany({});
      await prisma.bookingIntent.deleteMany({});
      await prisma.itineraryRevisionSegment.deleteMany({});
      await prisma.itineraryRevision.deleteMany({});
      await prisma.disruptionAuditEvent.deleteMany({});
      await prisma.notificationOutbox.deleteMany({});
      await prisma.bookingPassenger.deleteMany({});
      await prisma.booking.deleteMany({});
      await prisma.travelerProfile.deleteMany({});
      await prisma.offerRecovery.deleteMany({});
      await prisma.flightOffer.deleteMany({});
      await prisma.searchHistory.deleteMany({});
      await prisma.airport.deleteMany({});
      await prisma.auditLog.deleteMany({});
      await prisma.user.deleteMany({});;

  files.forEach(file => {
    const filePath = path.join(dir, file);
    let content = fs.readFileSync(filePath, 'utf8');
    
    // Find all consecutive prisma.X.deleteMany calls and replace them
    const regex = /(?:\s*await prisma\.[a-zA-Z]+\.deleteMany\([^)]*\);)+/g;
    
    content = content.replace(regex, (match) => {
      // If it's the one that ends with user.deleteMany({}), we replace it with comprehensive
      if (match.includes('user.deleteMany')) {
        return '\n' + comprehensiveCleanup + '\n';
      }
      return match; // Otherwise leave it alone
    });
    
    fs.writeFileSync(filePath, content);
  });
  console.log('Cleanup fixed');
})();
