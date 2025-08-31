import dotenv from 'dotenv';
import { ChatHandler } from './api/chatHandler.js';

// Load environment variables
dotenv.config();

class DatabaseTester {
  constructor() {
    this.chatHandler = new ChatHandler();
  }

  async testAllDatabaseOperations() {
    console.log('🔍 BACHELOR PARTY DATABASE ANALYSIS');
    console.log('=====================================\n');
  
    try {
      await this.testAvailableCities();
      await this.testServicesForPopularCities();
      await this.testServiceTypeDistribution();
      await this.testServiceDetails();
      await this.testKeywordSearches();
      await this.testChatbotFlow();
  
      // NEW: explicitly verify that prices are flowing through after your ChatHandler fix
      await this.testPriceCoverage();
    } catch (error) {
      console.error('❌ Error during testing:', error);
    }
  }

  async testAvailableCities() {
    console.log('📍 AVAILABLE CITIES');
    console.log('===================');
    
    const cities = await this.chatHandler.getAvailableCities();
    
    if (cities.error) {
      console.log('❌ Error:', cities.error);
      return;
    }
    
    console.log(`Found ${cities.cities.length} cities:`);
    cities.cities.forEach((city, index) => {
      console.log(`${index + 1}. ${city.name} (ID: ${city.id})`);
    });
    console.log('\n');
  }

  async testServicesForPopularCities() {
    console.log('🏙️  SERVICES BY CITY');
    console.log('====================');
  
    const testCities = ['Austin', 'Las Vegas', 'Montreal', 'Toronto', 'Miami', 'Nashville'];
  
    for (const city of testCities) {
      console.log(`\n--- ${city.toUpperCase()} ---`);
  
      const services = await this.chatHandler.searchServices({
        city_name: city,
        max_results: 20
      });
  
      if (services.error) {
        console.log(`❌ ${services.error}`);
        continue;
      }
  
      if (services.services.length === 0) {
        console.log(`⚠️  No services found for ${city}`);
        continue;
      }
  
      console.log(`✅ Found ${services.services.length} services:`);
  
      // Group by service type
      const byType = {};
      services.services.forEach(service => {
        if (!byType[service.type]) byType[service.type] = [];
        byType[service.type].push(service);
      });
  
      Object.entries(byType).forEach(([type, serviceList]) => {
        console.log(`  ${type}: ${serviceList.length} services`);
        serviceList.slice(0, 3).forEach(service => {
          const priced = this.hasPrice(service);
          const labelCAD = this.fmtPrice(service.price_cad, 'CAD');
          const labelUSD = this.fmtPrice(service.price_usd, 'USD');
          console.log(
            `    - ${service.name} (${priced ? '💲' : 'N/A'}) ` +
            `[${labelCAD}${service.price_usd != null ? ' / ' + labelUSD : ''}]`
          );
        });
      });
    }
    console.log('\n');
  }

  async testServiceTypeDistribution() {
    console.log('📊 SERVICE TYPE ANALYSIS');
    console.log('=========================');
    
    const serviceTypes = ['Restaurant', 'Bar', 'Night Club', 'Daytime', 'Transportation'];
    
    // Test Austin specifically since it's commonly used
    const testCity = 'Austin';
    console.log(`Analyzing service types for ${testCity}:\n`);
    
    for (const serviceType of serviceTypes) {
      const services = await this.chatHandler.searchServices({
        city_name: testCity,
        service_type: serviceType,
        max_results: 10
      });
      
      if (services.error) {
        console.log(`❌ ${serviceType}: Error - ${services.error}`);
        continue;
      }
      
      console.log(`${serviceType}: ${services.services.length} services`);
      
      if (services.services.length > 0) {
        console.log('  Top options:');
        services.services.slice(0, 3).forEach((service, index) => {
          console.log(`    ${index + 1}. ${service.name}`);
          console.log(`       Price: $${service.price_cad || 'N/A'} CAD`);
          console.log(`       Description: ${(service.description || '').substring(0, 80)}...`);
        });
      }
      console.log('');
    }
  }

  async testServiceDetails() {
    console.log('🔍 DETAILED SERVICE ANALYSIS');
    console.log('=============================');
  
    const austinServices = await this.chatHandler.searchServices({
      city_name: 'Austin',
      max_results: 5
    });
  
    if (austinServices.error || austinServices.services.length === 0) {
      console.log('❌ No services found for detailed analysis');
      return;
    }
  
    console.log('Examining first 3 services in detail:\n');
  
    for (let i = 0; i < Math.min(3, austinServices.services.length); i++) {
      const service = austinServices.services[i];
      console.log(`--- SERVICE ${i + 1}: ${service.name} ---`);
  
      const details = await this.chatHandler.getServiceDetails({
        service_id: service.id
      });
  
      if (details.error) {
        console.log(`❌ Error getting details: ${details.error}`);
        continue;
      }
  
      // Prefer the rolled-up prices from searchServices, but also show what details exposes
      const cadFromList = service.price_cad ?? null;
      const usdFromList = service.price_usd ?? null;
  
      const cadFromDetails =
        details?.pricing?.default_cad ??
        details?.pricing?.minimum_cad ??
        details?.pricing?.base_cad ??
        details?.pricing?.default_2_cad ??
        details?.pricing?.minimum_2_cad ?? null;
  
      const usdFromDetails =
        details?.pricing?.default_usd ??
        details?.pricing?.minimum_usd ??
        details?.pricing?.default_2_usd ??
        details?.pricing?.minimum_2_usd ?? null;
  
      const combinedCAD = cadFromList ?? cadFromDetails;
      const combinedUSD = usdFromList ?? usdFromDetails;
  
      console.log(`Type: ${details.type}`);
      console.log(`Description: ${details.description}`);
      console.log(
        `Pricing: ${this.fmtPricePair(combinedCAD, combinedUSD)} ` +
        `(list: ${this.fmtPricePair(cadFromList, usdFromList)}, details: ${this.fmtPricePair(cadFromDetails, usdFromDetails)})`
      );
      console.log(`Duration: ${details.timing?.duration_hours ?? 'N/A'} hours`);
      console.log(`City: ${details.city}`);
      console.log('');
    }
  }
  
  async testKeywordSearches() {
    console.log('🔎 KEYWORD SEARCH TESTING');
    console.log('==========================');
    
    const keywords = ['strip club', 'golf', 'boat', 'steakhouse', 'nightclub', 'bar'];
    
    for (const keyword of keywords) {
      console.log(`\nSearching for "${keyword}":`);
      
      const results = await this.chatHandler.searchServicesByKeyword({
        keyword: keyword,
        city_name: 'Austin'
      });
      
      if (results.error) {
        console.log(`❌ Error: ${results.error}`);
        continue;
      }
      
      console.log(`Found ${results.services.length} results`);
      results.services.slice(0, 3).forEach(service => {
        console.log(`  - ${service.name} (${service.type})`);
      });
    }
    console.log('\n');
  }

  async testChatbotFlow() {
    console.log('🤖 CHATBOT SELECTION FLOW SIMULATION');
    console.log('======================================');
    
    // Simulate what happens when the chatbot searches for services
    console.log('Simulating chatbot service search for Austin bachelor party...\n');
    
    const destination = 'Austin';
    const groupSize = 8;
    const wildnessLevel = 4;
    
    console.log(`Parameters: ${destination}, ${groupSize} people, wildness level ${wildnessLevel}\n`);
    
    // This mimics what searchAvailableServices does
    const serviceTypes = ['Restaurant', 'Bar', 'Night Club', 'Daytime', 'Transportation'];
    const allServices = [];
    
    for (const serviceType of serviceTypes) {
      const services = await this.chatHandler.searchServices({
        city_name: destination,
        service_type: serviceType,
        group_size: groupSize,
        max_results: 5
      });
      
      if (services.services) {
        allServices.push(...services.services.map(s => ({ ...s, type: serviceType })));
      }
    }
    
    console.log(`Total services found: ${allServices.length}`);
    
    // Group by type like the chatbot does
    const services = {
      restaurants: allServices.filter(s => s.type.toLowerCase() === 'restaurant'),
      bars: allServices.filter(s => s.type.toLowerCase() === 'bar'),
      nightclubs: allServices.filter(s => s.type.toLowerCase() === 'night club'),
      activities: allServices.filter(s => s.type.toLowerCase() === 'daytime'),
      transportation: allServices.filter(s => s.type.toLowerCase() === 'transportation')
    };
    
    console.log('\nServices by category:');
    Object.entries(services).forEach(([category, serviceList]) => {
      console.log(`  ${category}: ${serviceList.length} options`);
      if (serviceList.length > 0) {
        console.log(`    Top pick: ${serviceList[0].name}`);
      }
    });
    
    // Test the selection algorithm
    console.log('\n--- TESTING SERVICE SELECTION ALGORITHM ---');
    
    if (services.restaurants.length > 0) {
      const bestRestaurant = this.pickBestService(services.restaurants, groupSize, ['group', 'party', 'private']);
      console.log(`Best restaurant selected: ${bestRestaurant.name}`);
      console.log(`  Reason: Score based on keywords and price`);
    }
    
    if (wildnessLevel >= 4 && services.nightclubs.length > 0) {
      const bestNightclub = this.pickBestService(services.nightclubs, groupSize, ['vip', 'bottle', 'table']);
      console.log(`Best nightclub selected: ${bestNightclub.name}`);
      console.log(`  Reason: Wildness level ${wildnessLevel} >= 4, nightclub preferred`);
    } else if (services.bars.length > 0) {
      const bestBar = this.pickBestService(services.bars, groupSize, ['group', 'party']);
      console.log(`Best bar selected: ${bestBar.name}`);
      console.log(`  Reason: Wildness level ${wildnessLevel} < 4 or no nightclubs available`);
    }
    
    console.log('\n');
  }

  // Copy of the pickBestService method from ChatHandler for testing
  pickBestService(services, groupSize, keywords) {
    return services.sort((a, b) => {
      let scoreA = 0;
      let scoreB = 0;
  
      const aDesc = (a.description || '').toLowerCase();
      const bDesc = (b.description || '').toLowerCase();
  
      // Boost for relevant keywords
      keywords.forEach(keyword => {
        if (aDesc.includes(keyword)) scoreA += 2;
        if (bDesc.includes(keyword)) scoreB += 2;
      });
  
      // Prefer higher prices (fallback to USD if CAD missing)
      const aPrice = (a.price_cad ?? a.price_usd ?? 0);
      const bPrice = (b.price_cad ?? b.price_usd ?? 0);
      scoreA += aPrice * 0.01;
      scoreB += bPrice * 0.01;
  
      return scoreB - scoreA;
    })[0];
  }

  hasPrice(svc) {
    return svc && (svc.price_cad != null || svc.price_usd != null);
  }
  
  fmtPrice(v, currency = 'CAD') {
    return v != null ? `$${Number(v).toLocaleString()} ${currency}` : 'N/A';
  }
  
  fmtPricePair(cad, usd) {
    const cadStr = this.fmtPrice(cad, 'CAD');
    const usdStr = this.fmtPrice(usd, 'USD');
    if (cad != null && usd != null) return `${cadStr} / ${usdStr}`;
    if (cad != null) return cadStr;
    if (usd != null) return usdStr;
    return 'N/A';
  }
  
  // === ADD this brand-new method ===
  async testPriceCoverage() {
    console.log('🧪 PRICE COVERAGE CHECK');
    console.log('========================');
  
    const cities = ['Austin', 'Las Vegas', 'Montreal', 'Toronto', 'Miami', 'Nashville'];
  
    for (const city of cities) {
      const { services = [], error } = await this.chatHandler.searchServices({
        city_name: city,
        max_results: 100
      });
  
      if (error) {
        console.log(`❌ ${city}: Error - ${error}`);
        continue;
      }
  
      const total = services.length;
      const pricedAny = services.filter(s => this.hasPrice(s)).length;
      const cadOnly = services.filter(s => s.price_cad != null && s.price_usd == null).length;
      const usdOnly = services.filter(s => s.price_usd != null && s.price_cad == null).length;
      const both = services.filter(s => s.price_cad != null && s.price_usd != null).length;
      const none = total - pricedAny;
  
      const status = pricedAny > 0 ? '✅ PASS' : '❌ FAIL';
      console.log(
        `${status} ${city}: ${pricedAny}/${total} services have a price ` +
        `(CAD only: ${cadOnly}, USD only: ${usdOnly}, both: ${both}, none: ${none})`
      );
  
      if (none > 0) {
        console.log('   → Sample without price:');
        services
          .filter(s => !this.hasPrice(s))
          .slice(0, 5)
          .forEach(s => console.log(`     - ${s.name} (${s.type})`));
      } else {
        console.log('   → Sample with price:');
        services
          .filter(s => this.hasPrice(s))
          .slice(0, 5)
          .forEach(s => {
            console.log(`     - ${s.name}: ${this.fmtPricePair(s.price_cad, s.price_usd)}`);
          });
      }
    }
  
    console.log('');
  }
}

// Run the tests
async function runTests() {
  const tester = new DatabaseTester();
  await tester.testAllDatabaseOperations();
  
  console.log('✅ Database analysis complete!');
  console.log('\nTo run this script: node test-database.js');
  process.exit(0);
}

// Run if this file is executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  runTests().catch(console.error);
}