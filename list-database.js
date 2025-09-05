import dotenv from 'dotenv';
import { createClient } from '@supabase/supabase-js';

// Load environment variables
dotenv.config();

class DatabaseLister {
  constructor() {
    this.supabase = createClient(
      process.env.SUPABASE_URL, 
      process.env.SUPABASE_ANON_KEY
    );
  }

  async listAllItems() {
    console.log('🏢 DATABASE INVENTORY');
    console.log('====================\n');

    try {
      await this.listCities();
      await this.listAllServices();
      await this.showDatabaseStats();
    } catch (error) {
      console.error('❌ Error during database listing:', error);
    }
  }

  async listCities() {
    console.log('🏙️  CITIES');
    console.log('==========');
    
    try {
      const { data: cities, error } = await this.supabase
        .from('cities')
        .select('cit_id, cit_name')
        .order('cit_name');
        
      if (error) throw error;
      
      console.log(`Found ${cities.length} cities:\n`);
      cities.forEach((city, index) => {
        console.log(`${index + 1}. ${city.cit_name} (ID: ${city.cit_id})`);
      });
      console.log('\n');
      
      return cities;
    } catch (error) {
      console.error('❌ Error fetching cities:', error);
      return [];
    }
  }

  async listAllServices() {
    console.log('🎯 ALL SERVICES');
    console.log('===============');
    
    try {
      // Get all services with full details
      const { data: services, error } = await this.supabase
        .from('services')
        .select(`
          ser_id, ser_name, ser_type, ser_city_id,
          ser_description, ser_in_app_description,
          ser_itinerary_name, ser_itinerary_description,
          ser_duration_hrs, ser_show_in_app,
          ser_default_price_cad, ser_minimum_price_cad,
          ser_default_price_2_cad, ser_minimum_price_2_cad,
          ser_base_price_cad,
          ser_default_price_usd, ser_minimum_price_usd,
          ser_default_price_2_usd, ser_minimum_price_2_usd,
          cities(cit_name)
        `)
        .order('ser_city_id, ser_type, ser_name');
        
      if (error) throw error;
      
      // Group services by city
      const servicesByCity = {};
      services.forEach(service => {
        const cityName = service.cities?.cit_name || 'Unknown City';
        if (!servicesByCity[cityName]) {
          servicesByCity[cityName] = {};
        }
        
        const serviceType = service.ser_type || 'Other';
        if (!servicesByCity[cityName][serviceType]) {
          servicesByCity[cityName][serviceType] = [];
        }
        
        servicesByCity[cityName][serviceType].push(service);
      });
      
      // Display services grouped by city and type
      Object.entries(servicesByCity).forEach(([cityName, serviceTypes]) => {
        console.log(`\n--- ${cityName.toUpperCase()} ---`);
        
        Object.entries(serviceTypes).forEach(([serviceType, serviceList]) => {
          console.log(`\n  ${serviceType} (${serviceList.length} services):`);
          
          serviceList.forEach((service, index) => {
            const prices = this.formatPrices(service);
            const duration = service.ser_duration_hrs ? `${service.ser_duration_hrs}h` : 'N/A';
            const showInApp = service.ser_show_in_app ? '✅' : '❌';
            
            console.log(`    ${index + 1}. ${service.ser_name} (ID: ${service.ser_id})`);
            console.log(`       App: ${showInApp} | Duration: ${duration} | ${prices}`);
            
            if (service.ser_itinerary_name && service.ser_itinerary_name !== service.ser_name) {
              console.log(`       Itinerary Name: ${service.ser_itinerary_name}`);
            }
            
            if (service.ser_description) {
              const desc = service.ser_description.substring(0, 100);
              console.log(`       Description: ${desc}${service.ser_description.length > 100 ? '...' : ''}`);
            }
            
            console.log(''); // Empty line between services
          });
        });
      });
      
      return services;
    } catch (error) {
      console.error('❌ Error fetching services:', error);
      return [];
    }
  }

  formatPrices(service) {
    const cadPrices = [
      service.ser_default_price_cad,
      service.ser_minimum_price_cad,
      service.ser_default_price_2_cad,
      service.ser_minimum_price_2_cad,
      service.ser_base_price_cad
    ].filter(p => p != null);
    
    const usdPrices = [
      service.ser_default_price_usd,
      service.ser_minimum_price_usd,
      service.ser_default_price_2_usd,
      service.ser_minimum_price_2_usd
    ].filter(p => p != null);
    
    const parts = [];
    
    if (cadPrices.length > 0) {
      const cadRange = cadPrices.length === 1 
        ? `$${cadPrices[0]} CAD`
        : `$${Math.min(...cadPrices)}-$${Math.max(...cadPrices)} CAD`;
      parts.push(cadRange);
    }
    
    if (usdPrices.length > 0) {
      const usdRange = usdPrices.length === 1 
        ? `$${usdPrices[0]} USD`
        : `$${Math.min(...usdPrices)}-$${Math.max(...usdPrices)} USD`;
      parts.push(usdRange);
    }
    
    return parts.length > 0 ? parts.join(' / ') : 'No pricing';
  }

  async showDatabaseStats() {
    console.log('\n📊 DATABASE STATISTICS');
    console.log('======================');
    
    try {
      // City count
      const { data: cities } = await this.supabase
        .from('cities')
        .select('cit_id', { count: 'exact' });
      
      // Service counts
      const { data: allServices } = await this.supabase
        .from('services')
        .select('ser_id, ser_type, ser_show_in_app', { count: 'exact' });
      
      const { data: activeServices } = await this.supabase
        .from('services')
        .select('ser_id', { count: 'exact' })
        .eq('ser_show_in_app', true);
      
      // Service type breakdown
      const serviceTypes = {};
      allServices?.forEach(service => {
        const type = service.ser_type || 'Other';
        serviceTypes[type] = (serviceTypes[type] || 0) + 1;
      });
      
      // Pricing coverage
      const { data: pricedServices } = await this.supabase
        .from('services')
        .select('ser_id')
        .or('ser_default_price_cad.not.is.null,ser_minimum_price_cad.not.is.null,ser_default_price_usd.not.is.null,ser_minimum_price_usd.not.is.null,ser_base_price_cad.not.is.null');
      
      console.log(`Cities: ${cities?.length || 0}`);
      console.log(`Total Services: ${allServices?.length || 0}`);
      console.log(`Active Services (show_in_app=true): ${activeServices?.length || 0}`);
      console.log(`Services with Pricing: ${pricedServices?.length || 0}`);
      
      console.log('\nService Types:');
      Object.entries(serviceTypes)
        .sort(([,a], [,b]) => b - a)
        .forEach(([type, count]) => {
          console.log(`  ${type}: ${count} services`);
        });
      
      // Pricing coverage percentage
      if (allServices?.length > 0) {
        const pricingCoverage = ((pricedServices?.length || 0) / allServices.length * 100).toFixed(1);
        console.log(`\nPricing Coverage: ${pricingCoverage}%`);
      }
      
    } catch (error) {
      console.error('❌ Error generating stats:', error);
    }
  }

  async listServicesByCity(cityName) {
    console.log(`\n🎯 SERVICES IN ${cityName.toUpperCase()}`);
    console.log('='.repeat(20 + cityName.length));
    
    try {
      const { data: city } = await this.supabase
        .from('cities')
        .select('cit_id')
        .ilike('cit_name', cityName)
        .single();
      
      if (!city) {
        console.log(`❌ City "${cityName}" not found`);
        return;
      }
      
      const { data: services } = await this.supabase
        .from('services')
        .select(`
          ser_id, ser_name, ser_type,
          ser_description, ser_itinerary_name,
          ser_duration_hrs, ser_show_in_app,
          ser_default_price_cad, ser_minimum_price_cad,
          ser_default_price_usd, ser_minimum_price_usd,
          ser_base_price_cad
        `)
        .eq('ser_city_id', city.cit_id)
        .order('ser_type, ser_name');
      
      const servicesByType = {};
      services?.forEach(service => {
        const type = service.ser_type || 'Other';
        if (!servicesByType[type]) servicesByType[type] = [];
        servicesByType[type].push(service);
      });
      
      Object.entries(servicesByType).forEach(([type, serviceList]) => {
        console.log(`\n${type} (${serviceList.length} services):`);
        serviceList.forEach((service, index) => {
          const prices = this.formatPrices(service);
          const duration = service.ser_duration_hrs ? `${service.ser_duration_hrs}h` : 'N/A';
          const showInApp = service.ser_show_in_app ? '✅' : '❌';
          
          console.log(`  ${index + 1}. ${service.ser_name}`);
          console.log(`     ID: ${service.ser_id} | App: ${showInApp} | Duration: ${duration}`);
          console.log(`     Price: ${prices}`);
          
          if (service.ser_itinerary_name && service.ser_itinerary_name !== service.ser_name) {
            console.log(`     Itinerary: ${service.ser_itinerary_name}`);
          }
        });
      });
      
    } catch (error) {
      console.error(`❌ Error listing services for ${cityName}:`, error);
    }
  }
}

// Main execution function
async function listDatabase() {
  const lister = new DatabaseLister();
  
  // Get command line argument for specific city
  const cityFilter = process.argv[2];
  
  if (cityFilter) {
    await lister.listServicesByCity(cityFilter);
  } else {
    await lister.listAllItems();
  }
  
  console.log('\n✅ Database listing complete!');
  console.log('\nUsage:');
  console.log('  node list-database.js           # List everything');
  console.log('  node list-database.js Austin    # List services for specific city');
  
  process.exit(0);
}

// Run if this file is executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  listDatabase().catch(console.error);
}