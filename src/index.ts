import express from 'express';
import type { Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const app = express();
app.use(express.json());

app.post("/identify", async (req: Request, res: Response) => {
  try {
    const { email, phoneNumber } = req.body;

    if (!email && !phoneNumber) {
      return res.status(400).json({ error: "Email or Phone Number is required" });
    }

    const strPhone = phoneNumber ? String(phoneNumber) : null;
    const strEmail = email ? String(email) : null;

    // 1. Fetch related contacts
    const existingContacts = await prisma.contact.findMany({
      where: {
        OR: [
          { email: strEmail },
          { phoneNumber: strPhone },
        ],
      },
    });

    // 2. Scenario: Brand New User
    if (existingContacts.length === 0) {
      const newContact = await prisma.contact.create({
        data: {
          email: strEmail,
          phoneNumber: strPhone,
          linkPrecedence: "primary",
          linkedId: null, 
        },
      });

      return res.status(200).json({
        contact: {
          primaryContatctId: newContact.id,
          emails: [newContact.email].filter(Boolean),
          phoneNumbers: [newContact.phoneNumber].filter(Boolean),
          secondaryContactIds: [],
        },
      });
    }

    // 3. Identify Root Primary IDs
    let rootPrimaryIds = Array.from(new Set(
      existingContacts.map(c => c.linkPrecedence === "primary" ? c.id : c.linkedId!)
    ));

    // 4. Scenario: Merging "Islands"
    if (rootPrimaryIds.length > 1) {
      const primaries = await prisma.contact.findMany({
        where: { id: { in: rootPrimaryIds } },
        orderBy: { createdAt: 'asc' }
      });

      const actualRoot = primaries[0]!; 
      const othersToDowngrade = primaries.slice(1);

      for (const other of othersToDowngrade) {
        await prisma.contact.update({
          where: { id: other.id },
          data: { 
            linkPrecedence: "secondary", 
            linkedId: actualRoot.id 
          }
        });
        await prisma.contact.updateMany({
          where: { linkedId: other.id },
          data: { linkedId: actualRoot.id }
        });
      }
      rootPrimaryIds = [actualRoot.id];
    }

    const primaryId = rootPrimaryIds[0]!;

    // 5. Scenario: New Information Check
    const isNewEmail = strEmail && !existingContacts.some(c => c.email === strEmail);
    const isNewPhone = strPhone && !existingContacts.some(c => c.phoneNumber === strPhone);

    if (isNewEmail || isNewPhone) {
      await prisma.contact.create({
        data: {
          email: strEmail,
          phoneNumber: strPhone,
          linkedId: primaryId,
          linkPrecedence: "secondary",
        },
      });
    }

    // 6. Final Consolidation (Ensuring Primary Info is First)
    const allContacts = await prisma.contact.findMany({
      where: {
        OR: [{ id: primaryId }, { linkedId: primaryId }]
      },
      orderBy: { createdAt: 'asc' }
    });

    const primaryRecord = allContacts.find(c => c.id === primaryId)!;
    
    // Array logic to ensure Primary email/phone is at index [0]
    const emails = Array.from(new Set([
      primaryRecord.email, 
      ...allContacts.map(c => c.email)
    ])).filter((e): e is string => Boolean(e));

    const phoneNumbers = Array.from(new Set([
      primaryRecord.phoneNumber, 
      ...allContacts.map(c => c.phoneNumber)
    ])).filter((p): p is string => Boolean(p));

    const secondaryContactIds = allContacts
      .filter(c => c.id !== primaryId)
      .map(c => c.id);

    return res.status(200).json({
      contact: {
        primaryContatctId: primaryId,
        emails,
        phoneNumbers,
        secondaryContactIds
      }
    });

  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));