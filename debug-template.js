import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function debugTemplate() {
  console.log("=== TEMPLATE DEBUG SCRIPT ===\n");
  
  // Load the template
  const templatePath = path.resolve(__dirname, "prompts", "reducer.user.txt");
  console.log("Loading template from:", templatePath);
  
  const template = await fs.readFile(templatePath, 'utf8');
  console.log("Template loaded, size:", template.length, "bytes");
  
  // Check for encoding issues
  console.log("\n=== CHECKING FOR ENCODING ISSUES ===");
  
  // Check for BOM
  if (template.charCodeAt(0) === 0xFEFF) {
    console.error("❌ BOM detected at start of file!");
  } else {
    console.log("✅ No BOM detected");
  }
  
  // Check for weird characters
  const weirdChars = [];
  for (let i = 0; i < template.length; i++) {
    const code = template.charCodeAt(i);
    if (code > 127 && code !== 8217 && code !== 8216 && code !== 8220 && code !== 8221) {
      weirdChars.push({
        position: i,
        char: template[i],
        code: code,
        context: template.substring(Math.max(0, i - 20), Math.min(template.length, i + 20))
      });
    }
  }
  
  if (weirdChars.length > 0) {
    console.error(`❌ Found ${weirdChars.length} non-ASCII characters:`);
    weirdChars.slice(0, 10).forEach(wc => {
      console.log(`  Position ${wc.position}: char='${wc.char}' code=${wc.code}`);
      console.log(`  Context: ...${wc.context}...`);
    });
  } else {
    console.log("✅ No problematic non-ASCII characters found");
  }
  
  // Find all template expressions
  console.log("\n=== TEMPLATE EXPRESSIONS ===");
  const expressions = template.match(/\$\{[^}]+\}/g) || [];
  console.log(`Found ${expressions.length} expressions:`);
  
  expressions.forEach((expr, i) => {
    console.log(`\n${i + 1}. ${expr}`);
    
    // Check for problematic syntax
    if (expr.includes('?.')) {
      console.warn("   ⚠️  Contains optional chaining (?.)");
    }
    if (expr.includes('??')) {
      console.warn("   ⚠️  Contains nullish coalescing (??)");
    }
    if (expr.includes('=>')) {
      console.warn("   ⚠️  Contains arrow function");
    }
    if (expr.includes('`')) {
      console.warn("   ⚠️  Contains nested template literal");
    }
  });
  
  // Test render with mock data
  console.log("\n=== TEST RENDER WITH MOCK DATA ===");
  
  const mockConversation = {
    phase: 'gathering',
    facts: {
      destination: { value: 'Austin', status: 'set' },
      groupSize: { value: 8, status: 'set' },
      startDate: { value: null, status: 'unknown' },
      endDate: { value: null, status: 'unknown' }
    },
    messages: [],
    dayByDayPlanning: {
      currentDay: 0,
      currentDayPlan: null
    }
  };
  
  const mockContext = {
    currentYear: 2025,
    conversation: mockConversation,
    currentFacts: 'destination: Austin (set), groupSize: 8 (set)',
    recentMessages: 'user: test\nassistant: response',
    planningContext: '',
    userMessage: 'test message'
  };
  
  // Try to render
  try {
    console.log("Attempting to render with mock data...");
    
    // Simple test of problematic expression
    const testExpr = "conversation.dayByDayPlanning?.currentDay || 0";
    console.log(`\nTesting expression: ${testExpr}`);
    try {
      const testFn = new Function('conversation', `return ${testExpr}`);
      const result = testFn(mockConversation);
      console.log(`✅ Expression evaluated to: ${result}`);
    } catch (e) {
      console.error(`❌ Expression failed: ${e.message}`);
    }
    
    console.log("\n✅ Basic rendering test passed");
  } catch (e) {
    console.error("\n❌ Rendering failed:");
    console.error(e);
  }
}

debugTemplate().catch(console.error);