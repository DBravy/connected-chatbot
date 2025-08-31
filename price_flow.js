import dotenv from 'dotenv';
import { ChatHandler } from './api/chatHandler.js';
import { AIServiceSelector } from './api/aiServiceSelector.js';
import { AIResponseGenerator } from './api/aiResponseGenerator.js';

// Load environment variables
dotenv.config();

class PriceFlowDiagnostic {
  constructor() {
    this.chatHandler = new ChatHandler();
    this.aiSelector = new AIServiceSelector();
    this.aiResponseGenerator = new AIResponseGenerator();
  }

  logPriceInfo(obj, label) {
    const hasCad = obj.price_cad != null;
    const hasUsd = obj.price_usd != null;
    const cadVal = obj.price_cad;
    const usdVal = obj.price_usd;
    
    console.log(`  📊 ${label}: CAD=${hasCad ? '$' + cadVal : 'undefined'} USD=${hasUsd ? '$' + usdVal : 'undefined'}`);
  }

  async testPriceFlowEnd2End() {
    console.log('🔍 BACHELOR PARTY PRICE FLOW DIAGNOSTIC');
    console.log('=========================================\n');

    // Step 1: Test direct database search (like your test script does)
    console.log('STEP 1: Direct Database Search');
    console.log('==============================');
    
    const dbResults = await this.chatHandler.searchServices({
      city_name: 'Austin',
      max_results: 10
    });
    
    if (dbResults.error) {
      console.log(`❌ Database error: ${dbResults.error}`);
      return;
    }
    
    console.log(`✅ Database returned ${dbResults.services.length} services`);
    
    // Show pricing details for first few services
    console.log('\nPricing info from database:');
    dbResults.services.slice(0, 5).forEach((service, i) => {
      console.log(`${i + 1}. ${service.name} (ID: ${service.id})`);
      this.logPriceInfo(service, 'DB');
    });

    // Step 2: Test conversation setup and service search
    console.log('\n\nSTEP 2: Chatbot Conversation Setup');
    console.log('===================================');
    
    // Create a test conversation like the chatbot does
    const testConversation = this.chatHandler.getConversation('test-price-flow');
    
    // Set up facts to trigger planning phase
    this.chatHandler.setFact(testConversation, 'destination', 'Austin');
    this.chatHandler.setFact(testConversation, 'groupSize', 7);
    this.chatHandler.setFact(testConversation, 'startDate', '2025-09-05');
    this.chatHandler.setFact(testConversation, 'endDate', '2025-09-07');
    this.chatHandler.setFact(testConversation, 'wildnessLevel', 5);
    
    testConversation.phase = 'planning';
    
    // Step 3: Test searchServicesForConversation
    console.log('\nSTEP 3: searchServicesForConversation()');
    console.log('========================================');
    
    const conversationServices = await this.chatHandler.searchServicesForConversation(testConversation);
    
    console.log(`✅ Conversation search returned ${conversationServices.length} services`);
    console.log(`✅ conversation.availableServices has ${testConversation.availableServices.length} services`);
    
    // Compare specific services between DB and conversation results
    console.log('\nComparing pricing between DB and conversation search:');
    
    const dbServiceMap = new Map(dbResults.services.map(s => [s.id, s]));
    
    conversationServices.slice(0, 5).forEach((service, i) => {
      console.log(`\n${i + 1}. ${service.name} (ID: ${service.id})`);
      
      const dbVersion = dbServiceMap.get(service.id);
      if (dbVersion) {
        this.logPriceInfo(dbVersion, 'DB  ');
        this.logPriceInfo(service, 'CONV');
        
        const pricesMatch = (dbVersion.price_cad === service.price_cad) && 
                           (dbVersion.price_usd === service.price_usd);
        console.log(`  🔍 Prices match: ${pricesMatch ? '✅' : '❌'}`);
      } else {
        console.log('  ⚠️  Service not found in DB results');
      }
    });

    // Step 4: Test AI service selection
    console.log('\n\nSTEP 4: AI Service Selection');
    console.log('=============================');
    
    const userPreferences = this.chatHandler.transformConversationFacts(testConversation.facts);
    const dayInfo = {
      dayNumber: 1,
      totalDays: 3,
      timeSlots: ['afternoon', 'evening', 'night'],
      isFirstDay: true,
      isLastDay: false
    };
    
    console.log('User preferences:', JSON.stringify(userPreferences, null, 2));
    console.log('Available services for AI:', testConversation.availableServices.length);
    
    // Check if available services have pricing
    const availableWithPrices = testConversation.availableServices.filter(s => 
      s.price_cad != null || s.price_usd != null
    );
    console.log(`Services with pricing available to AI: ${availableWithPrices.length}/${testConversation.availableServices.length}`);
    
    try {
      const dayPlan = await this.aiSelector.selectOptimalServices(
        testConversation.availableServices,
        userPreferences,
        dayInfo
      );
      
      console.log(`✅ AI selected ${dayPlan.selectedServices.length} services`);
      
      // Check pricing in AI selection results
      console.log('\nPricing info from AI selection:');
      dayPlan.selectedServices.forEach((selected, i) => {
        console.log(`${i + 1}. ${selected.serviceName} (ID: ${selected.serviceId})`);
        
        // Find the original service in availableServices
        const original = testConversation.availableServices.find(s => String(s.id) === String(selected.serviceId));
        if (original) {
          this.logPriceInfo(original, 'ORIG');
          this.logPriceInfo(selected, 'SEL ');
          
          const hasOriginalPrice = original.price_cad != null || original.price_usd != null;
          const hasSelectedPrice = selected.price_cad != null || selected.price_usd != null;
          
          console.log(`  🔍 Original has price: ${hasOriginalPrice ? '✅' : '❌'}`);
          console.log(`  🔍 Selected has price: ${hasSelectedPrice ? '✅' : '❌'}`);
          
          if (hasOriginalPrice && !hasSelectedPrice) {
            console.log(`  🚨 PRICE LOST IN AI SELECTION!`);
          }
        } else {
          console.log(`  ⚠️  Original service not found in availableServices`);
        }
      });

      // Step 5: Test the enrichment that should happen
      console.log('\n\nSTEP 5: Manual Price Enrichment Test');
      console.log('=====================================');
      
      const byId = new Map(testConversation.availableServices.map(s => [String(s.id), s]));
      console.log(`Created lookup map with ${byId.size} services`);
      
      const enrichedServices = dayPlan.selectedServices.map(s => {
        const meta = byId.get(String(s.serviceId)) || {};
        console.log(`\nEnriching service ${s.serviceId}:`);
        console.log(`  - Original service:`, JSON.stringify(s, null, 2));
        console.log(`  - Metadata found:`, meta ? 'YES' : 'NO');
        if (meta) {
          this.logPriceInfo(meta, 'META');
        }
        
        const enriched = {
          ...s,
          price_cad: meta.price_cad ?? null,
          price_usd: meta.price_usd ?? null,
          duration_hours: meta.duration_hours ?? null
        };
        
        this.logPriceInfo(enriched, 'ENRI');
        return enriched;
      });

      // Step 6: Test response generation
      console.log('\n\nSTEP 6: Response Generation Test');
      console.log('=================================');
      
      const enrichedDayPlan = {
        ...dayPlan,
        selectedServices: enrichedServices
      };
      
      console.log('Services going into response generator:');
      enrichedDayPlan.selectedServices.forEach((service, i) => {
        console.log(`${i + 1}. ${service.serviceName} (ID: ${service.serviceId})`);
        this.logPriceInfo(service, 'RESP');
      });
      
      // Test the actual response generation
      try {
        const responseText = await this.aiResponseGenerator.generateItineraryResponse(
          enrichedDayPlan,
          dayInfo,
          userPreferences
        );
        
        console.log('\n✅ Response generated successfully');
        console.log('Response excerpt:', responseText.substring(0, 300) + '...');
        
        // Check if the response contains price information
        const priceRegex = /\$[\d,]+\s?(CAD|USD)/g;
        const pricesInResponse = responseText.match(priceRegex) || [];
        console.log(`Prices found in response: ${pricesInResponse.length > 0 ? pricesInResponse.join(', ') : 'NONE'}`);
        
      } catch (error) {
        console.log(`❌ Response generation failed: ${error.message}`);
      }

    } catch (error) {
      console.log(`❌ AI selection failed: ${error.message}`);
      console.log('Error details:', error);
    }

    // Step 7: Test the exact chatbot flow
    console.log('\n\nSTEP 7: Full Chatbot Flow Simulation');
    console.log('=====================================');
    
    try {
      // Reset conversation
      const chatConversation = this.chatHandler.getConversation('test-full-flow');
      
      // Seed with dev command to skip gathering phase
      const seedResult = await this.chatHandler.applyDevCommand(
        chatConversation, 
        '/seed Austin 7 2025-09-05..2025-09-07 wild=5 budget=flexible'
      );
      
      if (seedResult.handled) {
        console.log('✅ Seeded conversation successfully');
        console.log('Response excerpt:', seedResult.response.substring(0, 300) + '...');
        
        // Check the conversation state
        console.log(`Available services: ${chatConversation.availableServices.length}`);
        console.log(`Selected services: ${JSON.stringify(chatConversation.dayByDayPlanning?.currentDayPlan?.selectedServices?.length || 0)}`);
        
        if (chatConversation.dayByDayPlanning?.currentDayPlan?.selectedServices) {
          console.log('\nPricing in seeded conversation:');
          chatConversation.dayByDayPlanning.currentDayPlan.selectedServices.forEach((service, i) => {
            console.log(`${i + 1}. ${service.serviceName} (ID: ${service.serviceId})`);
            this.logPriceInfo(service, 'SEED');
          });
        }
        
        // Check if the response contains prices
        const priceRegex = /\$[\d,]+\s?(CAD|USD)/g;
        const pricesInSeedResponse = seedResult.response.match(priceRegex) || [];
        console.log(`Prices in seed response: ${pricesInSeedResponse.length > 0 ? pricesInSeedResponse.join(', ') : 'NONE'}`);
        
      } else {
        console.log('❌ Failed to seed conversation');
      }
      
    } catch (error) {
      console.log(`❌ Full flow test failed: ${error.message}`);
      console.log('Error details:', error);
    }

    // Summary
    console.log('\n\n📋 DIAGNOSTIC SUMMARY');
    console.log('=====================');
    console.log('This diagnostic traced the price data flow through:');
    console.log('1. Direct database search ✅');
    console.log('2. Conversation service search');
    console.log('3. AI service selection');
    console.log('4. Price enrichment');
    console.log('5. Response generation');
    console.log('6. Full chatbot flow simulation');
    console.log('\nLook for "🚨 PRICE LOST" messages above to identify where pricing breaks.');
    console.log('Compare the pricing info at each step to find the mismatch.');
  }

  // Helper method to do deep service comparison
  async compareServiceStructures() {
    console.log('\n\nBONUS: Service Structure Comparison');
    console.log('===================================');
    
    // Get a service from direct DB search
    const dbResult = await this.chatHandler.searchServices({
      city_name: 'Austin',
      service_type: 'Strip Club',
      max_results: 1
    });
    
    if (dbResult.services && dbResult.services[0]) {
      const dbService = dbResult.services[0];
      console.log('Database service structure:');
      console.log(JSON.stringify(dbService, null, 2));
      
      // Get the same service through conversation search
      const testConv = this.chatHandler.getConversation('test-structure');
      this.chatHandler.setFact(testConv, 'destination', 'Austin');
      this.chatHandler.setFact(testConv, 'groupSize', 7);
      
      const convServices = await this.chatHandler.searchServicesForConversation(testConv);
      const matchingConvService = convServices.find(s => s.id === dbService.id);
      
      if (matchingConvService) {
        console.log('\nConversation service structure (same service):');
        console.log(JSON.stringify(matchingConvService, null, 2));
        
        console.log('\nKey differences:');
        const dbKeys = Object.keys(dbService);
        const convKeys = Object.keys(matchingConvService);
        
        console.log(`DB keys: ${dbKeys.length}, Conv keys: ${convKeys.length}`);
        
        const missingInConv = dbKeys.filter(key => !convKeys.includes(key));
        const extraInConv = convKeys.filter(key => !dbKeys.includes(key));
        
        if (missingInConv.length) {
          console.log('Missing in conversation version:', missingInConv);
        }
        if (extraInConv.length) {
          console.log('Extra in conversation version:', extraInConv);
        }
        
        // Specifically check price field names
        console.log('\nPrice field comparison:');
        ['price_cad', 'price_usd', 'ser_default_price_cad', 'ser_default_price_usd'].forEach(field => {
          console.log(`  ${field}: DB=${dbService[field]} | Conv=${matchingConvService[field]}`);
        });
        
      } else {
        console.log('❌ Same service not found in conversation results');
      }
    }
  }

  // Method to test just the AI selector in isolation
  async testAISelectorIsolated() {
    console.log('\n\nSTEP 8: AI Selector Isolation Test');
    console.log('==================================');
    
    // Create services with known pricing
    const testServices = [
      {
        id: '38',
        name: 'Private Room at the Steakhouse',
        type: 'restaurant',
        category: 'restaurant',
        description: 'Your own space, world-class steaks, and all the whiskey you can handle',
        price_cad: 200,
        price_usd: 150,
        duration_hours: 2
      },
      {
        id: '3',
        name: 'Bar Hopping (Evening)',
        type: 'bar',
        category: 'bar',
        description: 'Tour Austin\'s best bars',
        price_cad: null,
        price_usd: 75,
        duration_hours: 3
      },
      {
        id: '64',
        name: 'Sprinter Van | BBQ & Beer Tour',
        type: 'daytime',
        category: 'daytime',
        description: 'Three hours, legendary Austin BBQ, local brews, and a private ride',
        price_cad: null,
        price_usd: 600,
        duration_hours: 3
      }
    ];
    
    console.log('Test services with known pricing:');
    testServices.forEach((service, i) => {
      console.log(`${i + 1}. ${service.name} (ID: ${service.id})`);
      this.logPriceInfo(service, 'TEST');
    });
    
    const userPreferences = {
      destination: 'Austin',
      groupSize: 7,
      wildnessLevel: 5,
      budget: 'flexible',
      specialRequests: 'having a great time'
    };
    
    const dayInfo = {
      dayNumber: 1,
      totalDays: 3,
      timeSlots: ['afternoon', 'evening', 'night'],
      isFirstDay: true,
      isLastDay: false
    };
    
    try {
      const result = await this.aiSelector.selectOptimalServices(
        testServices,
        userPreferences,
        dayInfo
      );
      
      console.log('\nAI Selector Results:');
      console.log(`Selected ${result.selectedServices.length} services`);
      
      result.selectedServices.forEach((selected, i) => {
        console.log(`\n${i + 1}. Selected: ${selected.serviceName} (ID: ${selected.serviceId})`);
        
        // Find original
        const original = testServices.find(s => String(s.id) === String(selected.serviceId));
        if (original) {
          this.logPriceInfo(original, 'ORIG');
          this.logPriceInfo(selected, 'AI  ');
          
          const hasOrigPrice = original.price_cad != null || original.price_usd != null;
          const hasSelPrice = selected.price_cad != null || selected.price_usd != null;
          
          if (hasOrigPrice && !hasSelPrice) {
            console.log('  🚨 AI SELECTOR DROPPED THE PRICING!');
          } else if (hasOrigPrice && hasSelPrice) {
            console.log('  ✅ AI Selector preserved pricing');
          } else {
            console.log('  ⚠️  Original had no pricing to preserve');
          }
        }
      });
      
    } catch (error) {
      console.log(`❌ AI Selector failed: ${error.message}`);
      console.log('Error:', error);
    }
  }

  // Method to test the response generator in isolation
  async testResponseGeneratorIsolated() {
    console.log('\n\nSTEP 9: Response Generator Isolation Test');
    console.log('==========================================');
    
    // Create a dayPlan with explicit pricing
    const testDayPlan = {
      selectedServices: [
        {
          serviceId: '38',
          serviceName: 'Private Room at the Steakhouse',
          timeSlot: 'evening',
          reason: 'Great for groups',
          estimatedDuration: '2 hours',
          groupSuitability: 'Perfect for 7 people',
          price_cad: 200,
          price_usd: 150
        },
        {
          serviceId: '3',
          serviceName: 'Bar Hopping (Evening)',
          timeSlot: 'night',
          reason: 'Classic nightlife',
          estimatedDuration: '3 hours',
          groupSuitability: 'Great for groups',
          price_cad: null,
          price_usd: 75
        }
      ],
      dayTheme: 'Epic first day',
      logisticsNotes: 'Start at 2pm'
    };
    
    const dayInfo = {
      dayNumber: 1,
      totalDays: 3,
      isLastDay: false
    };
    
    const userPreferences = {
      destination: 'Austin',
      groupSize: 7,
      wildnessLevel: 5,
      budget: 'flexible',
      specialRequests: 'having a great time'
    };
    
    console.log('Input to response generator:');
    testDayPlan.selectedServices.forEach((service, i) => {
      console.log(`${i + 1}. ${service.serviceName} (ID: ${service.serviceId})`);
      this.logPriceInfo(service, 'INPUT');
    });
    
    try {
      const response = await this.aiResponseGenerator.generateItineraryResponse(
        testDayPlan,
        dayInfo,
        userPreferences
      );
      
      console.log('\n✅ Response Generator Results:');
      console.log('Response excerpt:', response.substring(0, 400) + '...');
      
      // Check for prices in the response
      const priceRegex = /\$[\d,]+\s?(CAD|USD)/g;
      const foundPrices = response.match(priceRegex) || [];
      console.log(`Prices in response: ${foundPrices.length > 0 ? foundPrices.join(', ') : 'NONE FOUND'}`);
      
      if (foundPrices.length === 0) {
        console.log('🚨 RESPONSE GENERATOR IS NOT INCLUDING PRICES!');
        
        // Let's check what the generator actually receives
        console.log('\nDebugging response generator input...');
        console.log('Day plan structure:');
        console.log(JSON.stringify(testDayPlan, null, 2));
      }
      
    } catch (error) {
      console.log(`❌ Response Generator failed: ${error.message}`);
      console.log('Error:', error);
    }
  }
}

// Main execution function
async function runDiagnostic() {
  const diagnostic = new PriceFlowDiagnostic();
  
  try {
    await diagnostic.testPriceFlowEnd2End();
    await diagnostic.compareServiceStructures();
    await diagnostic.testAISelectorIsolated();
    await diagnostic.testResponseGeneratorIsolated();
    
    console.log('\n🎯 DIAGNOSTIC COMPLETE');
    console.log('======================');
    console.log('Review the output above to identify where pricing data is lost.');
    console.log('Look for "🚨 PRICE LOST" or "🚨 RESPONSE GENERATOR IS NOT INCLUDING PRICES" messages.');
    
  } catch (error) {
    console.error('❌ Diagnostic failed:', error);
  }
  
  process.exit(0);
}

// Run if this file is executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  runDiagnostic().catch(console.error);
}