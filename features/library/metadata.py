"""Bibliographic fields only; PDF producer/creation date never become book fields."""
import pathlib, zipfile, xml.etree.ElementTree as ET

def embedded_metadata(source, format=None):
    suffix=format or pathlib.Path(source).suffix.lower()
    if suffix=='.pdf':
        import pypdfium2 as pdfium
        with pdfium.PdfDocument(str(source)) as doc:
            info=doc.get_metadata_dict()
        return {'source':'pdf-metadata','title':info.get('Title',''),'author':info.get('Author','')}
    if suffix=='.epub':
        with zipfile.ZipFile(source) as z:
            infos=z.infolist()
            if len(infos)>20000 or sum(i.file_size for i in infos)>512*1024*1024:raise ValueError('EPUB 解压大小超限')
            container=ET.fromstring(z.read('META-INF/container.xml'))
            opf=next(e.attrib['full-path'] for e in container.iter() if e.tag.endswith('rootfile'))
            root=ET.fromstring(z.read(opf));dc='{http://purl.org/dc/elements/1.1/}'
            metadata=root.find('{http://www.idpf.org/2007/opf}metadata')
            if metadata is None:return {}
            def values(tag):return [''.join(e.itertext()).strip() for e in metadata.findall(dc+tag)]
            result={'source':'epub-metadata'}
            for key,tag in [('publisher','publisher'),('publishedDate','date'),('language','language')]:
                values_=values(tag)
                if values_:result[key]=values_[0]
            titles=metadata.findall(dc+'title')
            for e in titles:
                types=[m.text or '' for m in metadata if m.attrib.get('refines')=='#'+e.attrib.get('id','') and m.attrib.get('property')=='title-type']
                key='subtitle' if 'subtitle' in types else 'title'
                if key not in result or 'main' in types:result[key]=''.join(e.itertext()).strip()
            authors=[]
            for e in metadata.findall(dc+'creator'):
                role=e.attrib.get('{http://www.idpf.org/2007/opf}role','')
                roles=[m.text or '' for m in metadata if m.attrib.get('refines')=='#'+e.attrib.get('id','') and m.attrib.get('property')=='role']
                if (role and role!='aut') or (roles and 'aut' not in roles):continue
                authors.append(''.join(e.itertext()).strip())
            result['author']=authors
            for v in values('identifier'):
                if 'isbn' in v.lower() or len(v.replace('-','').replace(' ','')) in (10,13):result['isbn']=v;break
            return result
    return {}
