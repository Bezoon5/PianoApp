"""Stand-in for the homr command in tests: writes a fixed MusicXML next to the image.
STUB_MODE=fail exits with an error; STUB_MODE=slow sleeps past the server timeout."""
import os, shutil, sys, time
args = [a for a in sys.argv[1:] if not a.startswith('--')]
mode = os.environ.get('STUB_MODE', 'ok')
if '--init' in sys.argv: print('Init finished'); sys.exit(0)
image = args[-1]
if mode == 'fail': print('Error: no staffs found'); sys.exit(1)
if mode == 'slow': time.sleep(5)
src = os.environ.get('STUB_XML', os.path.join(os.path.dirname(__file__), '..', 'fixtures', 'homr-happy-birthday.musicxml'))
if '--output-tempo' in sys.argv: print('tempo', sys.argv[sys.argv.index('--output-tempo') + 1])
shutil.copy(src, os.path.splitext(image)[0] + '.musicxml')
print('Done')
