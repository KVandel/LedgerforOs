// Run with node --test pricing.test.cjs; tests exercise the functions in index.html.
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const html = fs.readFileSync(`${__dirname}/index.html`, 'utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
new vm.Script(script); // Parse the whole application, including template literals.
function source(name){
  const start = script.indexOf(`function ${name}(`);
  const end = script.indexOf('\n}', start) + 2;
  assert.ok(start >= 0 && end > start);
  return script.slice(start, end);
}
const context = vm.createContext({STATE:{settings:{rates:{MMK:1,USD:2000,THB:60}}}});
vm.runInContext(['convert','netUnitCost','computeLanded','computeSell','numericInputError','roundPriceUp'].map(source).join('\n'), context);
const money = (amt,cur='MMK')=>({amt,cur});
const cost = ()=>({unitCost:money(100000),qty:1,intl:money(20000),domestic:money(3000),lastMile:money(2000),agentMode:'percent',agentPct:10,agentFlat:money(5000)});
test('agent commission excludes every shipping leg', ()=>{
  const f = cost();
  assert.equal(context.computeLanded(f).agentMMK,10000);
  assert.equal(context.computeLanded(f).landed,135000);
  f.intl.amt = 90000;
  assert.equal(context.computeLanded(f).agentMMK,10000);
  assert.equal(context.computeLanded(f).landed,205000);
});
test('discount, quantity, mixed currencies and per-unit markup', ()=>{
  const f=cost();
  f.unitCost=context.netUnitCost(money(100,'USD'),20);
  f.qty=3; f.intl=money(100,'THB');
  const r=context.computeLanded(f);
  assert.equal(r.itemMMK,480000);
  assert.equal(r.agentMMK,48000);
  assert.equal(r.landed,539000);
  assert.equal(context.computeSell(r.landed/3,{marginPct:25}),539000/3*1.25);
});
test('flat fee is charged once per batch and zero commission works', ()=>{
  const f=cost(); f.qty=4; f.agentMode='flat'; f.agentFlat=money(100,'THB');
  assert.equal(context.computeLanded(f).agentMMK,6000);
  assert.equal(context.computeLanded(f).landed,431000);
  f.agentMode='percent'; f.agentPct=0;
  assert.equal(context.computeLanded(f).agentMMK,0);
  assert.equal(context.computeSell(100000,{marginMode:'flat',marginFlatMMK:5000}),105000);
});
test('quantity, fees, markup, shipping and mode changes recalculate immediately', ()=>{
  const elements = new Map();
  const get = id=>{
    if(!elements.has(id)) elements.set(id,{value:'0', listeners:{},classList:{toggle(){}},querySelectorAll(){return [];},addEventListener(event,fn){this.listeners[event]=fn;}});
    return elements.get(id);
  };
  let calls=0;
  const ui=vm.createContext({document:{getElementById:get},wireShipLeg(){},netUnitCost:context.netUnitCost,fmt2:String});
  vm.runInContext(source('wireCostForm'),ui);
  ui.wireCostForm('calc',()=>calls++);
  for(const key of ['qty','agentPct','agentFlat_amt','margin','marginFlat','intl_amt','dom_amt','last_amt']){
    const before=calls; get('calc_'+key).listeners.input(); assert.equal(calls,before+1,key);
  }
  for(const key of ['agentFlat_cur','intl_cur','dom_cur','last_cur']){
    const before=calls; get('calc_'+key).listeners.change(); assert.equal(calls,before+1,key);
  }
  for(const key of ['agentModeToggle','marginModeToggle']){
    const before=calls; get('calc_'+key).listeners.click({target:{closest:()=>({dataset:{mode:'flat'}})}}); assert.equal(calls,before+1,key);
  }
});
test('saved exchange rates stay fixed; explicit repricing uses current rates', ()=>{
  const f=cost(); f.unitCost=money(100,'USD'); f.ratesSnapshot={MMK:1,USD:1000,THB:30};
  assert.equal(context.computeLanded(f).landed,135000);
  assert.equal(context.computeLanded(f,{MMK:1,USD:3000,THB:90}).landed,355000);
  assert.equal(context.computeLanded(f).landed,135000);
  delete f.ratesSnapshot;
  assert.equal(context.computeLanded(f).landed,245000); // Legacy records use current rates.
});
test('rounding up preserves exact multiples and profit is based on rounded price', ()=>{
  for(const step of [1,100,500,1000]){
    assert.equal(context.roundPriceUp(10000,step),10000);
    assert.equal(context.roundPriceUp(10000.1,step),10000+step);
    assert.equal(context.roundPriceUp(0,step),0);
  }
  const suggested=context.roundPriceUp(context.computeSell(8150,{marginPct:25}),500);
  assert.equal(suggested,10500);
  assert.equal(suggested-8150,2350);
  assert.equal(context.computeSell(8150,{marginPct:0}),8150);
});
test('reject invalid numbers, quantities, discounts and exchange rates; accept zero markup', ()=>{
  for(const [value,id] of [['','calc_qty'],['0','calc_qty'],['1.5','calc_qty'],['-1','calc_orig_amt'],['Infinity','calc_agentPct'],['NaN','calc_margin'],['101','calc_discount'],['0','rate_USD'],['-10','cr_amt']]){
    assert.notEqual(context.numericInputError(value,id),'',`${id}: ${value}`);
  }
  for(const [value,id] of [['0','s_margin'],['0','calc_agentPct'],['100','calc_discount'],['2','calc_qty'],['0.01','rate_THB']]){
    assert.equal(context.numericInputError(value,id),'',`${id}: ${value}`);
  }
});
test('draft survives a fresh context, includes manual price/name/modes, and is account isolated', ()=>{
  const storage = new Map();
  const localStorage={getItem:key=>storage.get(key)||null,setItem:(key,value)=>storage.set(key,value)};
  const values={calc_orig_amt:'123',calc_name:'Lip tint',calc_actual:'15000',calc_rounding:'500',calc_agentMode:'flat',calc_intl_mode:'weight'};
  const ui=vm.createContext({CURRENT_UID:'user-a',CALC_ACTUAL_TOUCHED:true,localStorage,document:{getElementById:()=>({}),querySelectorAll:()=>Object.entries(values).map(([id,value])=>({id,value}))}});
  const code=['calculatorDraftKey','loadCalculatorDraft','saveCalculatorDraft'].map(source).join('\n');
  vm.runInContext(code,ui); ui.saveCalculatorDraft();
  const refreshed=vm.createContext({CURRENT_UID:'user-a',localStorage});
  vm.runInContext(code,refreshed);
  assert.deepEqual(JSON.parse(JSON.stringify(refreshed.loadCalculatorDraft())),{values,actualTouched:true});
  refreshed.CURRENT_UID='user-b'; assert.equal(refreshed.loadCalculatorDraft(),null);
  storage.set('ledger:pricing-draft:v1:user-b','broken json'); assert.equal(refreshed.loadCalculatorDraft(),null);
});
test('settings save retains zero markup and rejects a zero exchange rate', async ()=>{
  const listeners={};
  const fields={s_margin:'0',s_name:'Shop',rate_USD:'2500'};
  const elements=new Map();
  const get=id=>{
    if(!elements.has(id)) elements.set(id,{value:fields[id]||'',setCustomValidity(){},setAttribute(){},reportValidity(){},addEventListener(event,fn){listeners[id]=fn;}});
    return elements.get(id);
  };
  let writes=0;
  const ui=vm.createContext({STATE:{settings:{businessName:'Shop',marginPct:25,rates:{USD:2000},cargoRates:[]}},CURRENCIES:['MMK','USD'],CUR_LABEL:{USD:'USD'},document:{getElementById:get,querySelectorAll:()=>[]},escapeAttr:String,escapeHtml:String,sSet:async()=>{writes++;},toast(){},render(){}});
  vm.runInContext(['numericInputError','validateNumericFields','renderSettings'].map(source).join('\n'),ui);
  ui.renderSettings({innerHTML:''});
  await listeners.s_save();
  assert.equal(ui.STATE.settings.marginPct,0); assert.equal(writes,1);
  get('rate_USD').value='0'; await listeners.s_save();
  assert.equal(writes,1); assert.equal(ui.STATE.settings.rates.USD,2500);
});
