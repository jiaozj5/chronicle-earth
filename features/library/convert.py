"""Local conversion subprocess. JSON lines on stdout; no application database writes."""
import argparse, base64, io, json, os, sys, uuid, unicodedata, pathlib, zipfile, xml.etree.ElementTree as ET, subprocess, copy
from metadata import embedded_metadata

def emit(value):
    print(json.dumps(value, ensure_ascii=False), flush=True)
def text(value):
    return unicodedata.normalize('NFC', (value or '').replace('\r\n', '\n').replace('\r', '\n'))

def math_markup(element):
    element=copy.deepcopy(element);element.tail=None
    return ET.tostring(element,encoding='unicode')
def block(value, kind='paragraph', **extra):
    value=text(value)
    return dict(id='block_'+str(uuid.uuid4()), kind=kind, text=value, runs=[{'text':value}] if value else [], sourceRegions=[], recognition={'method':'native-text','status':'unreviewed','confidence':None}, **extra)
def image_data(image):
    out=io.BytesIO(); image.save(out, format='PNG'); return base64.b64encode(out.getvalue()).decode()
def ocr_regions(line):
    value=text(line['text']);regions=[];offset=0
    for word in line.get('words',[]):
        token=text(word['text']);start=value.find(token,offset)
        if start<0:continue
        end=start+len(token);regions.append({'start':start,'end':end,'rect':word['rect'],'precision':'word'});offset=end
    return regions
def windows_ocr(image_path):
    if sys.platform != 'win32': return None
    script=str(pathlib.Path(__file__).with_name('windows-ocr.ps1'))
    done=subprocess.run(['powershell.exe','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',script, str(image_path)], capture_output=True, creationflags=0x08000000)
    if done.returncode: return None
    try: return json.loads(done.stdout.decode('utf-8-sig'))
    except (ValueError, UnicodeError): return None
def convert_pdf(source, mode, outdir):
    import pypdfium2 as pdfium
    from outline import pdf_outline
    doc=pdfium.PdfDocument(str(source))
    emit({'event':'outline','items':pdf_outline(doc)})
    emit({'event':'start','pages':len(doc),'engine':'pdfium+windows-ocr' if mode=='auto' else 'pdfium'})
    for index in range(len(doc)):
        page=doc[index]; width,height=page.get_size()
        bitmap=page.render(scale=min(2,2400/max(width,height))); image=bitmap.to_pil()
        tp=page.get_textpage(); native=text(tp.get_text_range()).replace('\x00','')
        blocks=[]; warnings=[]; status='ready'
        # PDF text order is preserved as extraction, never claimed as reviewed.
        if native.strip():
            for paragraph in native.split('\n'):
                if paragraph.strip(): blocks.append(block(paragraph, pageIndex=index))
            warnings.append('原生文字未经校对；复杂版面与公式可使用增强转换。')
        if len(native.strip())<80 and mode=='auto':
            png=outdir/('page-'+str(index)+'.png');image.save(png)
            result=windows_ocr(png)
            if result and sum(len(l['text']) for l in result.get('lines',[]))>len(native.strip()):
                blocks=[];warnings=[]
                for line in result.get('lines',[]):
                    b=block(line['text'],pageIndex=index)
                    b['recognition']={'method':'ocr','status':'unreviewed','confidence':None,'engine':'Windows.Media.Ocr'}
                    b['sourceRegions']=[{'pageIndex':index,'rect':line['rect'],'precision':'line'}]
                    b['textRegions']=ocr_regions(line)
                    blocks.append(b)
                warnings.append('本机 OCR 文字未经校对；公式保留原图，未识别为 LaTeX。')
        if not blocks:
            status='needs-review';warnings.append('未提取到可用文字；保留原页，可区域批注或重试增强转换。')
        emit({'event':'page','page':{'index':index,'label':str(index+1),'width':width,'height':height,'status':status,'warnings':warnings},'blocks':blocks,'image':image_data(image)})
        tp.close();bitmap.close();page.close()
    doc.close();emit({'event':'complete'})

def convert_docling(source,outdir):
    from docling.document_converter import DocumentConverter, PdfFormatOption
    from docling.datamodel.base_models import InputFormat
    from docling.datamodel.pipeline_options import PdfPipelineOptions
    opts=PdfPipelineOptions();opts.do_ocr=True;opts.do_formula_enrichment=True
    opts.generate_page_images=True;opts.generate_picture_images=True;opts.images_scale=2
    result=DocumentConverter(format_options={InputFormat.PDF:PdfFormatOption(pipeline_options=opts)}).convert(str(source))
    doc=result.document; pages={}
    for no,p in doc.pages.items():
        pages[int(no)]={'page':{'index':int(no)-1,'label':str(no),'width':p.size.width,'height':p.size.height,'status':'ready','warnings':['自动识别结果未经人工校对。']},'blocks':[],'image':image_data(p.image.pil_image) if p.image else None}
    for item,level in doc.iterate_items():
        prov=getattr(item,'prov',[])
        if not prov or int(prov[0].page_no) not in pages: continue
        no=int(prov[0].page_no); page=pages[no]['page'];label=str(getattr(item,'label','')).lower().split('.')[-1]
        if label in ['page_header','page_footer']: continue
        raw=getattr(item,'text','')
        kind='formula' if label=='formula' else 'figure' if label=='picture' else 'heading' if label in ['title','section_header'] else 'paragraph'
        if label=='table':
            try: raw=item.export_to_markdown(doc=doc)
            except Exception: raw='[表格：请核对原页]'
        b=block(raw,kind,pageIndex=no-1)
        if kind=='formula': b.update(text='\ufffc',runs=[{'atom':'formula','latex':raw}],latex=raw)
        if kind=='figure': b.update(text='\ufffc',runs=[{'atom':'image','alt':'原书图片'}])
        b['recognition']={'method':'ocr','status':'unreviewed','confidence':None,'engine':'docling'}
        bbox=prov[0].bbox.to_top_left_origin(page['height'])
        rect=[bbox.l/page['width'],bbox.t/page['height'],(bbox.r-bbox.l)/page['width'],(bbox.b-bbox.t)/page['height']]
        if all(0<=v<=1 for v in rect) and rect[2]>0 and rect[3]>0:b['sourceRegions']=[{'pageIndex':no-1,'rect':rect,'precision':'block'}]
        if kind in ['formula','figure']:
            try: b['image']=image_data(item.get_image(doc))
            except Exception: pass
        pages[no]['blocks'].append(b)
    emit({'event':'start','pages':len(pages),'engine':'docling'})
    for p in pages.values(): emit({'event':'page',**p})
    emit({'event':'complete'})

def convert_image(source,outdir):
    from PIL import Image, ImageOps
    image=ImageOps.exif_transpose(Image.open(source)).convert('RGB');width,height=image.size
    image.thumbnail((2400,2400));png=outdir/'image.png';image.save(png)
    result=windows_ocr(png);blocks=[]
    for line in (result or {}).get('lines',[]):
        b=block(line['text'],pageIndex=0);b['recognition']={'method':'ocr','status':'unreviewed','confidence':None,'engine':'Windows.Media.Ocr'};b['sourceRegions']=[{'pageIndex':0,'rect':line['rect'],'precision':'line'}];b['textRegions']=ocr_regions(line);blocks.append(b)
    emit({'event':'start','pages':1,'engine':'windows-ocr'})
    emit({'event':'page','page':{'index':0,'label':'1','width':width,'height':height,'status':'ready' if blocks else 'needs-review','warnings':['OCR 及公式需要校对。']},'blocks':blocks,'image':image_data(image)})
    emit({'event':'complete'})

def convert_epub(source):
    import posixpath
    ET.register_namespace('', 'http://www.w3.org/1998/Math/MathML')
    with zipfile.ZipFile(source) as z:
        infos=z.infolist()
        if len(infos)>20000 or sum(i.file_size for i in infos)>512*1024*1024: raise ValueError('EPUB 解压大小超限')
        if len({i.filename for i in infos})!=len(infos):raise ValueError('EPUB 包含重复路径')
        for i in infos:
            if i.filename.startswith(('/','\\')) or '..' in i.filename.replace('\\','/').split('/'):raise ValueError('EPUB 路径无效')
        container=ET.fromstring(z.read('META-INF/container.xml'))
        opf=next(e.attrib['full-path'] for e in container.iter() if e.tag.endswith('rootfile'))
        root=ET.fromstring(z.read(opf));base=posixpath.dirname(opf)
        manifest={e.attrib['id']:e.attrib for e in root.iter() if e.tag.endswith('}item')}
        spine=[e.attrib['idref'] for e in root.iter() if e.tag.endswith('}itemref')]
        for item in manifest.values():
            if item.get('media-type','').startswith('image/'):
                key=posixpath.normpath(posixpath.join(base,item['href']))
                emit({'event':'asset','key':key,'mime':item['media-type'],'name':posixpath.basename(key),'data':base64.b64encode(z.read(key)).decode()})
        emit({'event':'start','pages':len(spine),'engine':'epub-xml'})
        def tag(e):return e.tag.split('}')[-1]
        for index,ref in enumerate(spine):
            name=posixpath.normpath(posixpath.join(base,manifest[ref]['href']));tree=ET.fromstring(z.read(name));blocks=[]
            def runs(e):
                result=[]
                if e.text:result.append({'text':text(e.text)})
                for child in e:
                    t=tag(child)
                    if t in ['script','style']: pass
                    elif t=='math':result.append({'atom':'formula','mathml':math_markup(child),'alt':'数学公式'})
                    elif t=='img':result.append({'atom':'image','assetKey':posixpath.normpath(posixpath.join(posixpath.dirname(name),child.attrib.get('src',''))),'alt':child.attrib.get('alt','图片')})
                    elif t=='br':result.append({'text':'\n'})
                    else:
                        for r in runs(child):
                            if t in ['strong','b']:r['bold']=True
                            if t in ['em','i']:r['italic']=True
                            result.append(r)
                    if child.tail:result.append({'text':text(child.tail)})
                return result
            def walk(e):
                t=tag(e)
                if t in ['script','style','head']:return
                if t in ['p','h1','h2','h3','h4','h5','h6','li','td','th','pre']:
                    rs=runs(e);value=''.join('\ufffc' if r.get('atom') else r.get('text','') for r in rs)
                    if value.strip():
                        b=block(value,'heading' if t.startswith('h') and t[1:].isdigit() else 'table-cell' if t in ['td','th'] else 'paragraph',pageIndex=index);b['runs']=rs;b['level']=int(t[1]) if t.startswith('h') and t[1:].isdigit() else 0;blocks.append(b)
                elif t in ['img','math']:
                    rs=[{'atom':'formula','mathml':math_markup(e)}] if t=='math' else [{'atom':'image','assetKey':posixpath.normpath(posixpath.join(posixpath.dirname(name),e.attrib.get('src',''))),'alt':e.attrib.get('alt','图片')}]
                    b=block('\ufffc','formula' if t=='math' else 'figure',pageIndex=index);b['runs']=rs;blocks.append(b)
                else:
                    for c in e:walk(c)
            walk(tree)
            emit({'event':'page','page':{'index':index,'label':'章节 '+str(index+1),'width':720,'height':1000,'status':'ready','warnings':[]},'blocks':blocks})
        emit({'event':'complete'})

if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('source',nargs='?');parser.add_argument('--mode',default='auto');parser.add_argument('--output');parser.add_argument('--check',action='store_true');parser.add_argument('--metadata',action='store_true');parser.add_argument('--format');a=parser.parse_args()
    if a.check:
        import importlib.util
        ocr={'available':False,'languages':[]}
        if sys.platform=='win32':
            try:
                checked=subprocess.run(['powershell.exe','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',str(pathlib.Path(__file__).with_name('windows-ocr.ps1')),'-Check'],capture_output=True,timeout=4,creationflags=0x08000000)
                ocr=json.loads(checked.stdout.decode('utf-8-sig'))
            except Exception: pass
        emit({'pdfium':bool(importlib.util.find_spec('pypdfium2')),'docling':bool(importlib.util.find_spec('docling')),'windowsOcr':ocr['available'],'ocrLanguages':ocr['languages'],'python':sys.executable})
    else:
        try:
            source=pathlib.Path(a.source).resolve()
            if a.metadata:
                # The stored attachment has no extension; the caller supplies its format.
                from metadata import embedded_metadata as read_metadata
                emit(read_metadata(source, **({'format':a.format} if a.format else {})));sys.exit(0)
            try:emit({'event':'metadata','metadata':embedded_metadata(source)})
            except Exception:emit({'event':'metadata','metadata':{}})
            outdir=pathlib.Path(a.output).resolve();outdir.mkdir(parents=True,exist_ok=True)
            if source.suffix.lower()=='.epub':convert_epub(source)
            elif a.mode=='docling':convert_docling(source,outdir)
            elif source.suffix.lower() in ['.png','.jpg','.jpeg','.webp','.tif','.tiff']:convert_image(source,outdir)
            else:convert_pdf(source,a.mode,outdir)
        except Exception as e:
            emit({'event':'error','message':str(e),'type':type(e).__name__});sys.exit(1)
