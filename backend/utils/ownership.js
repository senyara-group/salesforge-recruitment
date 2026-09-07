function owned(query, userId) {
  return query.eq('user_id', userId);
}

function ownedById(query, userId, id) {
  return query.eq('id', id).eq('user_id', userId);
}

function ownedConversationMessages(query, userId, conversationId) {
  return query.eq('conversation_id', conversationId).eq('user_id', userId);
}

function withOwner(values, userId) {
  return { ...values, user_id: userId };
}

module.exports = { owned, ownedById, ownedConversationMessages, withOwner };
