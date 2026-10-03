import { createHash, randomBytes } from 'node:crypto';
import { aesEncryptGCM, hmacSign, proto, type WAMessage, type WAMessageKey } from '@whiskeysockets/baileys';
import { describe, expect, it } from 'vitest';
import { readPollVote } from '../src';

const ME_PN = '201000000001@s.whatsapp.net';
const ME_LID = '11111@lid';
const CUSTOMER_PN = '201012345678@s.whatsapp.net';
const CUSTOMER_LID = '99999@lid';
const POLL_ID = '3EB0POLL';
const OPTIONS = ['اطلب الآن 🛒', 'أرسل لي التفاصيل', 'لا، شكراً'];

const secret = randomBytes(32);
const poll: proto.IMessage = {
  messageContextInfo: { messageSecret: secret },
  pollCreationMessageV3: { name: 'هل يهمك العرض؟', selectableOptionsCount: 1, options: OPTIONS.map((optionName) => ({ optionName })) },
};

/** Encrypts a vote the way the voter's phone does, addressing the creator and voter as given. */
function vote(key: WAMessageKey, chosen: string[], creatorJid: string, voterJid: string): WAMessage {
  const sign = Buffer.concat([Buffer.from(POLL_ID), Buffer.from(creatorJid), Buffer.from(voterJid), Buffer.from('Poll Vote'), new Uint8Array([1])]);
  const encKey = hmacSign(sign, hmacSign(secret, new Uint8Array(32), 'sha256'), 'sha256');
  const plain = proto.Message.PollVoteMessage.encode({ selectedOptions: chosen.map((o) => createHash('sha256').update(o).digest()) }).finish();
  const encIv = randomBytes(12);
  const encPayload = aesEncryptGCM(plain, encKey, encIv, Buffer.from(`${POLL_ID}\u0000${voterJid}`));
  return {
    key: { id: 'VOTE1', ...key },
    message: { pollUpdateMessage: { pollCreationMessageKey: { id: POLL_ID, remoteJid: key.remoteJid, fromMe: true }, vote: { encPayload, encIv } } },
  } as WAMessage;
}

describe('readPollVote', () => {
  it('decodes a vote addressed by phone numbers', () => {
    const msg = vote({ remoteJid: CUSTOMER_PN, fromMe: false }, [OPTIONS[0]!], ME_PN, CUSTOMER_PN);
    expect(readPollVote(msg, poll, [`201000000001:7@s.whatsapp.net`, ME_LID])).toEqual({
      waMessageId: POLL_ID,
      chatJid: CUSTOMER_PN,
      voter: CUSTOMER_PN,
      voterPhone: '+201012345678',
      selected: [OPTIONS[0]],
    });
  });

  it('decodes a vote addressed by LIDs and reports the phone number when known', () => {
    const msg = vote({ remoteJid: CUSTOMER_LID, remoteJidAlt: CUSTOMER_PN, fromMe: false }, [OPTIONS[1]!], ME_LID, CUSTOMER_LID);
    expect(readPollVote(msg, poll, [ME_PN, '11111:7@lid'])).toMatchObject({ voter: CUSTOMER_PN, voterPhone: '+201012345678', selected: [OPTIONS[1]] });
  });

  it('decodes a LID vote with no phone number', () => {
    const msg = vote({ remoteJid: CUSTOMER_LID, fromMe: false }, [OPTIONS[2]!], ME_LID, CUSTOMER_LID);
    expect(readPollVote(msg, poll, [ME_PN, ME_LID])).toMatchObject({ voter: CUSTOMER_LID, voterPhone: null, selected: [OPTIONS[2]] });
  });

  it('reads the voter from the participant in groups', () => {
    const msg = vote({ remoteJid: '1203630@g.us', participant: CUSTOMER_PN, fromMe: false }, [OPTIONS[0]!], ME_PN, CUSTOMER_PN);
    expect(readPollVote(msg, poll, [ME_PN, ME_LID])).toMatchObject({ chatJid: '1203630@g.us', voter: CUSTOMER_PN, selected: [OPTIONS[0]] });
  });

  it('reports a withdrawn vote as an empty choice', () => {
    const msg = vote({ remoteJid: CUSTOMER_PN, fromMe: false }, [], ME_PN, CUSTOMER_PN);
    expect(readPollVote(msg, poll, [ME_PN, ME_LID])?.selected).toEqual([]);
  });

  it('returns null when the vote does not decrypt', () => {
    const msg = vote({ remoteJid: CUSTOMER_PN, fromMe: false }, [OPTIONS[0]!], ME_PN, CUSTOMER_PN);
    const otherPoll = { ...poll, messageContextInfo: { messageSecret: randomBytes(32) } };
    expect(readPollVote(msg, otherPoll, [ME_PN, ME_LID])).toBeNull();
  });
});
