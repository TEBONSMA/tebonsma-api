import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { Caller } from '../src/authelia.ts'
import { getMembers } from '../src/members.ts'
import { createArticle, saveImage, setFront, setPublished, type ArticleInput, type Publication } from '../src/press.ts'

// Example articles for The Tebonsma Times and Tebonsma Tidsskrift, for `npm run dev:mock:demo`.
// Pictures come from TebBet's member photos when that repo is next to this one.

const petter: Caller = { username: 'petter', groups: ['medlemmer', 'times_redaksjon'] }
const eirik: Caller = { username: 'eirik', groups: ['medlemmer', 'tidsskrift_redaksjon'] }
const members = await getMembers(['petter', 'eirik', 'dev', 'kari', 'ola'])
const id = (username: string) => members.get(username)!.id

const PHOTOS = resolve('../tebbet/public/flaks/medlemmer')
function photo(publication: Publication, caller: Caller, name: string) {
  const file = resolve(PHOTOS, `${name}.jpg`)
  return existsSync(file) ? saveImage(publication, caller, readFileSync(file)).url : null
}

const p = (...paragraphs: string[]) => paragraphs.map(text => (text.startsWith('<') ? text : `<p>${text}</p>`)).join('')

type Seed = Omit<ArticleInput, 'coverImage' | 'tags' | 'coverCaption' | 'issue'> & { photo?: string; caption?: string; tags?: string[]; front?: number; draft?: boolean }

async function seed(publication: Publication, caller: Caller, articles: Seed[]) {
  const ids: { id: string; front?: number }[] = []
  // Oldest first, so the first in the list is the newest
  for (const article of [...articles].reverse()) {
    const made = await createArticle(publication, caller, {
      ...article,
      tags: article.tags ?? [],
      coverImage: article.photo ? photo(publication, caller, article.photo) : null,
      coverCaption: article.caption ?? '',
      issue: '',
    })
    if (!article.draft) await setPublished(publication, made.id, caller, true)
    ids.push({ id: made.id, front: article.front })
  }
  const front = ids.filter(a => a.front !== undefined).sort((a, b) => a.front! - b.front!)
  await setFront(publication, front.map(a => a.id), caller)
}

await seed('times', petter, [
  {
    title: 'Pling gjenvalgt for femte gang – opposisjonen roper «riksrett»',
    section: 'Innenriks',
    lead: 'Årsmøtet endte som ventet: Generalkommissæren fortsetter. Men nestledervalget ble et kaos ingen helt forstår.',
    body: p(
      'Det tok under to timer. Så var Pling gjenvalgt som generalkommissær, uten motkandidat og med akklamasjon fra et samlet årsmøte, minus én.',
      '– Riksrett! ropte Gjøran fra bakerste rad, før møteleder minnet om at det er han som er møteleder.',
      '<h2>Nestledervalget</h2>',
      'Referatet sier det best selv: «Oskar stemmes inn – kødda, ble Claus». Ingen har siden klart å forklare hva som skjedde mellom de to tankestrekene.',
      '<blockquote><p>Det e æ som e møteleder.</p></blockquote>',
      'Regnskapet ble for andre år på rad utsatt. Komiteen for logo fortsetter sitt arbeid.',
    ),
    authors: [{ id: id('petter'), alias: 'Petter «Abraham» Lona' }],
    visibility: 'public',
    photo: 'pling',
    caption: 'Generalkommissæren etter gjenvalget. Foto: Tebonsma Times',
    tags: ['årsmøtet', 'valg'],
    front: 0,
  },
  {
    title: 'Eivind kom 47 minutter for sent til pulebordet: – Toget gikk',
    section: 'Pulebord',
    lead: 'Innkallingen sa 12:30 (EIVIND!). Eivind kom 13:17. Mann med stokk har varslet refs.',
    body: p(
      'For fjerde år på rad sto navnet hans i innkallingen, med utropstegn. For fjerde år på rad hjalp det ikke.',
      '– Det gikk ikke noe tog dit, sier en kilde i hovedkvarteret til Tebonsma Times.',
      'Saken behandles på kveldens refsutdeling.',
    ),
    authors: [{ id: id('petter') }, { id: id('kari') }],
    visibility: 'members',
    photo: 'kris',
    caption: 'Ankom 13:17.',
    tags: ['pulebordet', 'forsinkelser'],
    front: 1,
  },
  {
    title: 'Ser Schmid avslører årets heksebrygg: – Det beste siden Napoleon',
    section: 'Kultur',
    lead: 'Sommelieren med den lengste CV-en i Trøndelag lover et brygg som «utfordrer ganen og vedtektene».',
    body: p(
      'Det er få som vet hva som er i årets heksebrygg. Ser Schmid selv sier han vet det, men vil ikke si det.',
      '<h2>Smak, lukt og opplevelse</h2>',
      'Som i fjor får hver flaske poeng i tre kategorier. Fjorårets brygg smakes også, for sammenligningens skyld.',
    ),
    authors: [{ id: id('ola') }],
    visibility: 'members',
    photo: 'magne',
    tags: ['spritsmaking'],
    front: 2,
  },
  {
    title: 'Blåturen 2026: Kraków overlevde – nesten',
    section: 'Reise',
    lead: 'Ni mann, fire dager, null GPS-snoking. Turkomiteen kaller det en suksess.',
    body: p('Ingen spurte «hvor skal vi?». Én ble dømt til dobbel kefing likevel.', 'Mann med lokal stokk ble valgt på hvert sted, som vedtektene sier.'),
    authors: [{ id: id('petter') }],
    visibility: 'public',
    photo: 'johan',
    tags: ['blåtur'],
    front: 3,
  },
  {
    title: 'Leder: Regnskapet kommer. Snart.',
    section: 'Meninger',
    lead: 'Årsmøtet vedtok å «FAKTISK begynne å føre regnskap». Vi heier.',
    body: p('To årsmøter på rad er regnskapet utsatt. Det er ikke en tradisjon vi trenger flere av.'),
    authors: [{ id: id('petter') }],
    visibility: 'public',
    tags: ['økonomi'],
  },
  {
    title: 'Doorknob-saken: ankenemnda frikjenner Claus',
    section: 'Rett og vrang',
    lead: 'Farskapstesten var ikke entydig, mener de uinvolverte. Refsen er annullert.',
    body: p('«Kæm faen dufa no?» ble aldri besvart. Nå er saken lukket.'),
    authors: [{ id: id('kari') }],
    visibility: 'members',
    photo: 'remi',
    tags: ['§6'],
  },
  {
    title: 'Brøttem Brygge åpner for sesongen',
    section: 'Distrikt',
    lead: 'Klæbus Magaluf er klar. Ikke forveksle med Brøttem Beach.',
    body: p('Storbonden lover lave priser og høy partyfaktor.'),
    authors: [{ id: id('ola') }],
    visibility: 'public',
  },
  {
    title: 'Utkast: Kongens nyttårstale – hva vet vi?',
    section: 'Innenriks',
    lead: 'Et utkast som ikke er publisert ennå.',
    body: p('Bare redaksjonen ser dette.'),
    authors: [{ id: id('petter') }],
    visibility: 'members',
    draft: true,
  },
])

await seed('tidsskrift', eirik, [
  {
    title: 'Underbergens farmakokinetikk ved gjentatt berging: en kohortstudie fra GPB04',
    section: 'Originalartikkel',
    lead: 'BAKGRUNN: Bergingsparagrafen (§5) pålegger umiddelbar inntak av funnet Underberg. Virkningen ved gjentatt berging er lite studert. MATERIALE OG METODE: Ni deltakere ble fulgt gjennom ett pulebord. RESULTATER: Smaken ble rapportert som «tilvennbar» av sju av ni. FORTOLKNING: Tilvenning skjer, men tar tid.',
    body: p(
      '<h2>Bakgrunn</h2>',
      'Berging er en sentral praksis i brorskapet, men den vitenskapelige litteraturen er tynn.',
      '<h2>Materiale og metode</h2>',
      'Deltakerne ble observert fra velkomstdrink til lukking av julebordet. Funnsteder ble registrert, med unntak av ugyldige gjemmesteder (jakker og sekker).',
      '<h2>Resultater</h2>',
      '<ul><li>Median tid fra funn til inntak: 4 sekunder.</li><li>Én pussy-out ble registrert.</li></ul>',
      '<h2>Diskusjon</h2>',
      'Studien er begrenset av lite utvalg og høy bedrukkenhet blant observatørene.',
    ),
    authors: [{ id: id('eirik') }, { id: id('dev') }],
    visibility: 'public',
    tags: ['berging', 'Underberg', 'kohortstudie'],
    front: 0,
  },
  {
    title: 'Akutt forsinkelse hos mann i 20-årene: en kasuistikk',
    section: 'Kasuistikk',
    lead: 'Vi beskriver en pasient med kronisk forsinkelse til avtalte tider, med akutt forverring ved pulebord og blåturer.',
    body: p('Pasienten oppga at «toget gikk». Ingen tog gikk.', '<h2>Diskusjon</h2>', 'Tilstanden er godt kjent i miljøet, men dårlig forstått.'),
    authors: [{ id: id('eirik') }],
    visibility: 'members',
    tags: ['forsinkelse', 'kasuistikk'],
    front: 1,
  },
  {
    title: 'Hvorfor vedtektene trenger flere drikkeleker',
    section: 'Leder',
    lead: 'Minimumskravet på tre drikkeleker per arrangement er et minimum. Det bør vi huske.',
    body: p('Vedtektenes §14 er et godt utgangspunkt, men forskningen peker i én retning.'),
    authors: [{ id: id('eirik') }],
    visibility: 'public',
    front: 2,
  },
  {
    title: 'Jarritos-preferanser i et lukket brorskap: en dobbeltblindet smakstest',
    section: 'Originalartikkel',
    lead: 'BAKGRUNN: Den offisielle topplisten (§16.2) har sju punkter, men kaller seg topp 10. METODE: Blindet smakstest. RESULTATER: Lime beholder førsteplassen.',
    body: p('<h2>Metode</h2>', 'Deltakerne smakte sju smaker i tilfeldig rekkefølge.', '<h2>Resultater</h2>', 'Lime vant. Mexican Cola delte meningene.'),
    authors: [{ id: id('eirik') }, { id: id('kari') }, { id: id('ola') }],
    visibility: 'public',
    tags: ['Jarritos', 'smakstest'],
  },
  {
    title: 'Fisens farskap: en systematisk oversikt over §6-praksis 2022–2026',
    section: 'Oversiktsartikkel',
    lead: 'Vi gjennomgikk alle kjente doorknob-saker. Snifftesten er fortsatt den mest brukte metoden for farskapsbestemmelse.',
    body: p('Oversikten bygger på referater og vitnemål.'),
    authors: [{ id: id('dev') }],
    visibility: 'members',
    tags: ['§6', 'systematisk oversikt'],
  },
])

console.log('demo: articles for The Tebonsma Times and Tebonsma Tidsskrift')
