import express from "express";
import type { Request, Response } from "express"; // Added 'type' here
import { PrismaClient } from "@prisma/client";

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

    // 1. Fetch all potentially related contacts
    const existingContacts = await prisma.contact.findMany({
      where: {
        OR: [
          { email: email ?? undefined },
          { phoneNumber: strPhone ?? undefined },
        ],
      },
    });

    // 2. Scenario: Brand New User
    if (existingContacts.length === 0) {
      const newContact = await prisma.contact.create({
        data: {
          email: email ?? null,
          phoneNumber: strPhone,
          linkPrecedence: "primary",
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

    // 3. Identify all unique primary IDs involved
    // If a contact is secondary, we look at its linkedId. If primary, we use its own ID.
    let rootPrimaryIds = Array.from(new Set(
      existingContacts.map(c => c.linkPrecedence === "primary" ? c.id : c.linkedId!)
    ));

    // 4. Scenario: Merging two existing Primary "Islands"
    // This happens if email matches Primary A and phone matches Primary B.
    if (rootPrimaryIds.length > 1) {
      // Find the actual primary records to find the oldest one
      const primaries = await prisma.contact.findMany({
        where: { id: { in: rootPrimaryIds } },
        orderBy: { createdAt: 'asc' }
      });

      const actualRoot = primaries[0];
      const othersToDowngrade = primaries.slice(1);

      for (const other of othersToDowngrade) {
        // Turn the newer primary into a secondary of the oldest one
        await prisma.contact.update({
          where: { id: other.id },
          data: { 
            linkPrecedence: "secondary", 
            linkedId: actualRoot.id 
          }
        });
        // Also update any secondary contacts that were pointing to the downgraded primary
        await prisma.contact.updateMany({
          where: { linkedId: other.id },
          data: { linkedId: actualRoot.id }
        });
      }
      rootPrimaryIds = [actualRoot.id];
    }

    const primaryId = rootPrimaryIds[0];

    // 5. Scenario: New Information for an existing user
    // Check if the current request contains an email or phone we haven't seen in this cluster
    const isNewEmail = email && !existingContacts.some(c => c.email === email);
    const isNewPhone = strPhone && !existingContacts.some(c => c.phoneNumber === strPhone);

    if (isNewEmail || isNewPhone) {
      await prisma.contact.create({
        data: {
          email: email ?? null,
          phoneNumber: strPhone,
          linkedId: primaryId,
          linkPrecedence: "secondary",
        },
      });
    }

    // 6. Consolidate final response
    // Fetch the entire family tree (Primary + all Secondaries)
    const allContacts = await prisma.contact.findMany({
      where: {
        OR: [
          { id: primaryId },
          { linkedId: primaryId }
        ]
      },
      orderBy: { createdAt: 'asc' }
    });

    const primaryRecord = allContacts.find(c => c.id === primaryId)!;
    
    // Ensure the primary email/phone comes first in the arrays
    const emails = Array.from(new Set([
      primaryRecord.email, 
      ...allContacts.map(c => c.email)
    ])).filter(Boolean);

    const phoneNumbers = Array.from(new Set([
      primaryRecord.phoneNumber, 
      ...allContacts.map(c => c.phoneNumber)
    ])).filter(Boolean);

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
const PORT = 3000;
app.listen(PORT, () => {
  console.log(`Server is running on http://localhost:${PORT}`);
});
