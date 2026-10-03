"""Read PDF bookmarks without rendering, OCR, or modifying the source."""
import json, sys

def pdf_outline(doc):
    entries=[]
    for item in doc.get_toc():
        if len(entries)>=5000: break
        destination=item.get_dest()
        page=destination.get_index() if destination else None
        title=item.get_title().strip()
        if title and page is not None and 0<=page<len(doc):
            entries.append({'id':'pdf-outline-'+str(len(entries)), 'title':title[:500], 'pageIndex':page, 'level':min(12,item.level+1), 'source':'pdf-bookmarks'})
    return entries

if __name__=='__main__':
    import pypdfium2 as pdfium
    with pdfium.PdfDocument(sys.argv[1]) as doc:
        print(json.dumps(pdf_outline(doc),ensure_ascii=True))
