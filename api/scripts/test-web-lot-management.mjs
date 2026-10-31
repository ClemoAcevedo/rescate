import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { chromium } from 'playwright'
const base=(process.env.WEB_URL??'https://localhost:5174').replace(/\/$/,'')
assert.ok(process.env.DATABASE_URL && /^rescate_web_test_/.test(new URL(process.env.DATABASE_URL).pathname.slice(1)))
const db=new pg.Client({connectionString:process.env.DATABASE_URL});await db.connect()
const browser=await chromium.launch({headless:true})
const context=await browser.newContext({ignoreHTTPSErrors:true,viewport:{width:360,height:800}})
const page=await context.newPage(), email=`e2-web-${randomUUID()}@example.invalid`, password='Clave-segura-E2-browser'
const pageErrors=[];page.on('pageerror',error=>pageErrors.push(error.message))
try {
  await page.goto(base+'/login')
  const registered=await page.evaluate(async ({email,password})=>{
    const {csrfToken}=await(await fetch('/api/auth/session')).json()
    return (await fetch('/api/auth/register',{method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':csrfToken},body:JSON.stringify({email,password,privacyConsent:true})})).status
  },{email,password});assert.equal(registered,201)
  const user=(await db.query('SELECT id FROM users WHERE email=$1',[email])).rows[0]
  const est=(await db.query(`INSERT INTO establishments(name,address,latitude,longitude,time_zone)
    VALUES ('E2 navegador','Santiago',-33.45,-70.66,'America/Santiago') RETURNING id`)).rows[0]
  await db.query('INSERT INTO memberships(user_id,establishment_id) VALUES ($1,$2)',[user.id,est.id])
  const lot=(await db.query(`INSERT INTO lots(establishment_id,description,category,quantity,address,latitude,longitude,time_zone,
    pickup_starts_at,pickup_ends_at,status,published_at) VALUES ($1,'Dos berlines','Panadería',2,'Santiago',-33.45,-70.66,
    'America/Santiago',now()-interval '1 hour',now()+interval '2 hours','published',now()) RETURNING public_id::text AS id`,[est.id])).rows[0]
  await page.goto(base+'/login?from='+encodeURIComponent('/operador/lotes/'+lot.id))
  await page.locator('input[name="email"]').fill(email);await page.locator('input[name="password"]').fill(password)
  await page.getByRole('button',{name:'Iniciar sesión',exact:true}).click()
  const panel=page.getByRole('region',{name:'Gestionar disponibilidad'})
  await panel.getByText('Libres:',{exact:false}).waitFor()
  async function operate(action,reason,quantity) {
    await panel.getByLabel('Acción').selectOption(action)
    if(quantity) await panel.getByLabel('Packs que ya no están disponibles').fill(String(quantity))
    await panel.getByLabel('Motivo').fill(reason)
    const completed=page.waitForResponse(response=>response.url().endsWith('/management')&&response.request().method()==='POST')
    await panel.getByRole('button',{name: action==='pause'?'Pausar publicación':action==='resume'?'Reactivar publicación':action==='withdraw'?'Retirar publicación':'Descontar stock',exact:true}).click()
    if(action==='withdraw') await panel.getByRole('button',{name:'Confirmar retiro de publicación'}).click()
    assert.equal((await completed).status(),200)
    await panel.getByText(/operación confirmada/).waitFor()
  }
  await operate('reduce_stock','Un berlin vendido en el local',1)
  await operate('pause','Pausa para revisar el mostrador')
  await panel.getByText('Publicación pausada',{exact:true}).waitFor()
  await operate('resume','Stock revisado')
  await panel.getByText('Publicación pausada',{exact:true}).waitFor({state:'hidden'})
  // Simular respuesta perdida después de que el servidor confirmó el descuento.
  let firstKey=null;let lost=false
  await page.route('**/lots/*/management',async route=>{
    if(route.request().method()!=='POST'){await route.continue();return}
    const body=route.request().postDataJSON()
    if(body.action!=='reduce_stock'){await route.continue();return}
    if(!lost){firstKey=body.idempotencyKey;lost=true;await route.fetch();await route.abort('failed')}
    else {assert.equal(body.idempotencyKey,firstKey);await route.continue()}
  })
  await panel.getByLabel('Acción').selectOption('reduce_stock')
  await panel.getByLabel('Packs que ya no están disponibles').fill('1')
  await panel.getByLabel('Motivo').fill('Último berlin vendido')
  await panel.getByRole('button',{name:'Descontar stock',exact:true}).click()
  await panel.getByRole('button',{name:'Reintentar la misma operación'}).click()
  await panel.getByText(/operación confirmada/).waitFor()
  assert.equal((await db.query('SELECT expired_quantity FROM lots WHERE public_id=$1',[lot.id])).rows[0].expired_quantity,2)
  await page.unroute('**/lots/*/management')
  await operate('withdraw','Fin de la publicación')
  await panel.getByText(/Retirar publicación: operación confirmada/).waitFor()
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true)
  assert.deepEqual(pageErrors,[])
  console.log('PASS E2 navegador: venta local, pausa, reactivación, respuesta perdida sin duplicar, retiro confirmado y 360 px')
} finally {await browser.close();await db.end()}
