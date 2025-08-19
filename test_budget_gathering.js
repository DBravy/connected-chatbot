import { ChatHandler } from './lib/chatHandler.js';
import { PHASES, FIELD_STATUS } from './lib/conversationState.js';

async function testBudgetGathering() {
  console.log('🧪 Testing Budget Gathering During Gathering Phase\n');

  const chatHandler = new ChatHandler();
  const conversationId = 'test-budget-gathering';

  try {
    // Start conversation
    console.log('1. Starting conversation...');
    let conversation = chatHandler.getConversation(conversationId);
    console.log(`   Initial phase: ${conversation.phase}`);
    console.log(`   Initial budget status: ${conversation.facts.budget.status}\n`);

    // Provide essential facts first
    console.log('2. Providing essential facts...');
    await chatHandler.handleMessage(conversationId, "Las Vegas, 8 guys, September 6th to 8th");
    conversation = chatHandler.getConversation(conversationId);
    console.log(`   Phase after essentials: ${conversation.phase}`);
    console.log(`   Destination: ${conversation.facts.destination.value}`);
    console.log(`   Group size: ${conversation.facts.groupSize.value}`);
    console.log(`   Start date: ${conversation.facts.startDate.value}`);
    console.log(`   End date: ${conversation.facts.endDate.value}\n`);

    // Answer helpful facts including budget
    console.log('3. Providing helpful facts including budget...');
    
    // First helpful fact question
    const response1 = await chatHandler.handleMessage(conversationId, "We want it pretty wild, like a 4 out of 5");
    console.log(`   Response: ${response1.response.substring(0, 100)}...`);
    
    conversation = chatHandler.getConversation(conversationId);
    console.log(`   Wildness level: ${conversation.facts.wildnessLevel.value}\n`);

    // Continue with other helpful facts
    const response2 = await chatHandler.handleMessage(conversationId, "We're college buddies");
    console.log(`   Response: ${response2.response.substring(0, 100)}...`);
    
    conversation = chatHandler.getConversation(conversationId);
    console.log(`   Relationship: ${conversation.facts.relationship.value}\n`);

    // Answer about activities
    const response3 = await chatHandler.handleMessage(conversationId, "Strip clubs, pool parties, and good restaurants");
    console.log(`   Response: ${response3.response.substring(0, 100)}...`);
    
    conversation = chatHandler.getConversation(conversationId);
    console.log(`   Activities: ${conversation.facts.interestedActivities.value}\n`);

    // Answer age range
    const response4 = await chatHandler.handleMessage(conversationId, "We're all in our late 20s");
    console.log(`   Response: ${response4.response.substring(0, 100)}...`);
    
    conversation = chatHandler.getConversation(conversationId);
    console.log(`   Age range: ${conversation.facts.ageRange.value}\n`);

    // Now test budget gathering - this should be asked about since it's now HELPFUL
    const response5 = await chatHandler.handleMessage(conversationId, "$3000 total for the group");
    console.log(`   Response: ${response5.response.substring(0, 100)}...`);
    
    conversation = chatHandler.getConversation(conversationId);
    console.log(`   Budget: ${conversation.facts.budget.value}`);
    console.log(`   Budget status: ${conversation.facts.budget.status}`);
    console.log(`   Phase after budget: ${conversation.phase}\n`);

    // Verify all helpful facts are addressed
    console.log('4. Checking if all helpful facts are addressed...');
    const helpfulFacts = ['wildnessLevel', 'relationship', 'interestedActivities', 'ageRange', 'budget'];
    
    helpfulFacts.forEach(factName => {
      const fact = conversation.facts[factName];
      console.log(`   ${factName}: ${fact.value} (${fact.status})`);
    });

    // Check if we can transition to planning
    console.log(`\n5. Final phase check: ${conversation.phase}`);
    
    if (conversation.phase === PHASES.PLANNING) {
      console.log('✅ SUCCESS: Budget gathering works! Transitioned to planning phase.');
    } else {
      console.log('⚠️  Still in gathering phase - may need one more interaction to transition.');
    }

  } catch (error) {
    console.error('❌ Test failed:', error);
  }
}

// Run the test
testBudgetGathering().catch(console.error); 